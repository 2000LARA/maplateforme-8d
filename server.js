require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_RESET_KEY = process.env.ADMIN_RESET_KEY || null;

// In-memory session tokens: token -> { username, role, createdAt }
// (Simple and effective for a small internal app; tokens are lost on server
// restart, which just means users need to log in again.)
const activeSessions = new Map();
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function issueToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.set(token, { username: user.username, role: user.role, createdAt: Date.now() });
  return token;
}

function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const session = token ? activeSessions.get(token) : null;

  if (!session) {
    return res.status(401).json({ error: 'Non authentifié. Veuillez vous reconnecter.' });
  }
  if (Date.now() - session.createdAt > TOKEN_TTL_MS) {
    activeSessions.delete(token);
    return res.status(401).json({ error: 'Session expirée. Veuillez vous reconnecter.' });
  }
  req.user = session;
  next();
}

// Security headers
app.use(helmet({
  contentSecurityPolicy: false // disabled to avoid breaking inline scripts in this app; can be tightened later
}));

// Rate limiting on auth endpoints to slow down brute-force attempts
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Trop de tentatives. Réessayez dans quelques minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure upload directory exists
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer setup for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo max par fichier
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|webp/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only images are allowed!'));
  }
});

// JSON DB Helper functions
const DB_PATH = path.join(__dirname, 'data', 'db.json');

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    return { users: [], claims: [] };
  }
  try {
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading database file:', err);
    return { users: [], claims: [] };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing to database file:', err);
  }
}

// Auto-seed function to match dashboard screenshots exactly:
// Total claims: 45, En cours: 42, Stellantis: 40, Renault: 5, Actions en retard: 1
function seedDatabase() {
  const db = readDB();
  if (db.claims && db.claims.length > 0) {
    return; // database already has data (real or seeded) — never overwrite
  }

  console.log('Seeding initial claims data...');
  const claims = [];

  const plants = ['Tanger', 'Tarnava', 'Zaragoza', 'VIGO'];
  const answerers = ['Bilal', 'Manal', 'Youssef', 'Sara'];
  const defectDescriptions = [
    'Leakage condenser',
    'Condenser leakage',
    'Power regulator malfunction',
    'Terminal demi-insertion',
    'PTC not working',
    'The stepper motor is not working correctly',
    'Heater leakage',
    'Alternator noise',
    'Water pump pressure failure'
  ];
  const products = [
    'Condenser XL',
    'Alternator 12V',
    'PTC Heater V5',
    'Stepper Motor M2',
    'Hose Premium',
    'Water Pump W3'
  ];

  // Helper to generate dynamic dates in 2026 matching screenshots (2/2026, 4/2026, 6/2026, 8/2026)
  const getMockDate = (index) => {
    const months = ['02', '04', '06', '08'];
    const month = months[index % months.length];
    const day = String(10 + (index % 18)).padStart(2, '0');
    return `${day}/${month}/2026`;
  };

  // Generate 45 claims (40 Stellantis, 5 Renault)
  for (let i = 1; i <= 45; i++) {
    const isRenault = i > 40; // 41 to 45 are Renault (5 claims), 1 to 40 are Stellantis (40 claims)
    const customer = isRenault ? 'Renault' : 'Stellantis';
    
    // Status distribution: 3 CLOSED, 42 En cours
    // 2 Stellantis closed, 1 Renault closed
    let currentStep = 0;
    let status = 'D0 en cours';
    let validatedSteps = [];

    if (i === 10 || i === 20 || i === 41) {
      // These 3 are CLOSED
      currentStep = 8;
      status = 'CLOSED';
      validatedSteps = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    } else {
      // Rest are en cours, distributed across steps
      const steps = [0, 1, 2, 3, 4, 5, 6, 7];
      currentStep = steps[i % steps.length];
      status = `D${currentStep} en cours`;
      for (let s = 0; s < currentStep; s++) {
        validatedSteps.push(s);
      }
    }

    const claimDateStr = getMockDate(i);
    // Parse claim date to calculate deadline
    // Stellantis deadline: claimDate + 15 days
    // Renault deadline: claimDate + 30 days
    const parts = claimDateStr.split('/');
    const claimDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    const deadlineDate = new Date(claimDate);
    deadlineDate.setDate(deadlineDate.getDate() + (isRenault ? 30 : 15));
    
    const dStr = String(deadlineDate.getDate()).padStart(2, '0');
    const mStr = String(deadlineDate.getMonth() + 1).padStart(2, '0');
    const yStr = deadlineDate.getFullYear();
    const deadlineStr = `${dStr}/${mStr}/${yStr}`;

    const id = i < 10 ? `8D-2026-000${i}` : `Q20260087${4000 + i}`;
    
    // Check if one action is late (1 action en retard)
    // We'll mark claim #5 as having an action delayed (Claim date early 2026, still en cours)
    const hasLateAction = (i === 5);

    const claim = {
      id: id,
      whoAnswered: answerers[i % answerers.length],
      plant: plants[i % plants.length],
      customer: customer,
      productReference: products[i % products.length],
      urgency: i % 3 === 0 ? 'High' : i % 3 === 1 ? 'Medium' : 'Low',
      claimDate: claimDateStr,
      officialDate: i % 2 === 0 ? getMockDate(i + 1) : '-',
      receptionDateOfProduct: claimDateStr,
      deadline: deadlineStr,
      okmWarranty: i % 4 === 0 ? 'Warranty' : 'OKM',
      incidentLevel: i % 3 === 0 ? 'A' : i % 3 === 1 ? 'G1' : 'G2',
      problemDescription: defectDescriptions[i % defectDescriptions.length],
      currentStep: currentStep,
      status: status,
      validatedSteps: validatedSteps,
      hasLateAction: hasLateAction,
      history: [
        {
          timestamp: new Date().toISOString(),
          user: 'admin',
          action: 'Création de la réclamation'
        }
      ],
      d0: {
        whoAnswered: answerers[i % answerers.length],
        customer: customer,
        plant: plants[i % plants.length],
        productReference: products[i % products.length],
        urgency: i % 3 === 0 ? 'High' : i % 3 === 1 ? 'Medium' : 'Low',
        claimDate: claimDateStr,
        deadline: deadlineStr,
        officialDate: i % 2 === 0 ? getMockDate(i + 1) : '-',
        daysOpen: 12
      },
      d1: {
        teamLeader: answerers[i % answerers.length],
        members: ['Jean Dupont', 'Marie Curie', 'Pierre Berger']
      },
      d2: {
        problemDescription: defectDescriptions[i % defectDescriptions.length],
        riskMatrix: {
          severity: (i % 5) + 1,
          occurrence: (i % 4) + 1,
          detection: (i % 3) + 1
        }
      },
      d3: {
        nbrBL: 'BL-2026-' + (1000 + i),
        actions: [
          {
            id: 1,
            action: 'Tri et isolement des pièces suspectes en stock',
            nbrBL: 'BL-2026-' + (1000 + i),
            who: answerers[i % answerers.length],
            when: claimDateStr,
            status: 'Fait',
            image: '',
            isLate: hasLateAction
          }
        ]
      },
      d4: {
        ishikawa: {
          matiere: ['Pièces de fonderie poreuses', 'Qualité de l\'alliage non-conforme'],
          milieu: ['Température élevée en atelier', 'Humidité excessive'],
          methode: ['Vitesse de serrage inadaptée', 'Absence d\'instruction visuelle'],
          machine: ['Usure du joint d\'étanchéité', 'Jeu mécanique dans l\'arbre de transmission'],
          mainOeuvre: ['Opérateur non formé sur ce poste', 'Fatigue en fin d\'équipe'],
          mesure: ['Calibrage du manomètre dépassé', 'Erreur de lecture de la jauge']
        },
        fiveWhys: [
          {
            path: 'Occurrence',
            why1: 'Pourquoi la fuite s\'est-elle produite ? - Le joint d\'étanchéité s\'est rompu prématurément.',
            why2: 'Pourquoi s\'est-il rompu ? - Il a subi un frottement excessif et continu.',
            why3: 'Pourquoi ce frottement ? - Il y avait un jeu mécanique anormal au niveau de l\'arbre.',
            why4: 'Pourquoi ce jeu ? - Les vis de fixation de l\'arbre se sont desserrées à cause des vibrations.',
            why5: 'Pourquoi se sont-elles desserrées ? - Le couple de serrage appliqué au montage était insuffisant (Cause Racine).',
            otherCauses: 'Qualité du lubrifiant limite mais dans les tolérances.',
            rootCause: 'Couple de serrage insuffisant au montage'
          },
          {
            path: 'Non-détection',
            why1: 'Pourquoi la fuite n\'a pas été détectée en usine ? - Le banc de test final n\'a rien signalé.',
            why2: 'Pourquoi ? - Le test se fait à basse pression pendant seulement 5 secondes.',
            why3: 'Pourquoi cette durée ? - Cadence de production trop élevée pour un test long.',
            why4: 'Pourquoi ? - Pas d\'analyse de capabilité du banc de test de fuite.',
            why5: 'Pourquoi ? - Processus de validation du banc incomplet (Cause Racine).',
            otherCauses: 'Vitesse de rotation nominale non testée.',
            rootCause: 'Processus de validation du banc de test incomplet'
          },
          {
            path: 'Système',
            why1: 'Pourquoi les spécifications de serrage n\'étaient pas adaptées ? - Les plans n\'indiquaient pas la tolérance.',
            why2: 'Pourquoi ? - L\'étude AMDEC process n\'a pas identifié ce serrage comme critique.',
            why3: 'Pourquoi ? - Pas de participation de l\'expert méthodes à la revue de conception.',
            why4: 'Pourquoi ? - Planning surchargé et manque de ressources.',
            why5: 'Pourquoi ? - Procédure de jalonnage projet non respectée (Cause Racine).',
            otherCauses: 'Formation AMDEC trop générique.',
            rootCause: 'Non-respect de la procédure de revue AMDEC projet'
          }
        ]
      },
      d5: {
        actions: [
          {
            id: 101,
            action: 'Modifier la gamme de montage pour imposer un tournevis dynamométrique asservi',
            rootCauseSource: 'Couple de serrage insuffisant au montage',
            who: 'Youssef',
            when: deadlineStr,
            status: 'Planifié'
          },
          {
            id: 102,
            action: 'Mettre à jour le programme du banc de test de fuite pour augmenter le temps sous pression',
            rootCauseSource: 'Processus de validation du banc de test incomplet',
            who: 'Bilal',
            when: deadlineStr,
            status: 'Planifié'
          }
        ]
      },
      d6: {
        actions: [
          {
            id: 201,
            action: 'Validation industrielle du tournevis asservi et vérification des premiers lots',
            who: 'Manal',
            when: deadlineStr,
            status: 'Fait'
          }
        ]
      },
      d7: {
        actions: [
          {
            id: 301,
            action: 'Généraliser la revue de couple de serrage sur les autres lignes de production similaires',
            who: 'Youssef',
            when: deadlineStr,
            status: 'En cours'
          }
        ]
      },
      d8: {
        closureDate: currentStep === 8 ? claimDateStr : '',
        teamRecognized: currentStep === 8
      }
    };

    claims.push(claim);
  }

  db.claims = claims;
  writeDB(db);
  console.log('Database successfully seeded with 45 claims matching dashboard metrics!');
}

// Seed the database immediately on start
seedDatabase();

// --- API ROUTES ---

// Helper: check a plaintext password against a stored value that may be
// either a bcrypt hash (new accounts) or legacy plaintext (old seed data).
// Legacy plaintext matches are transparently upgraded to a hash on success.
function verifyAndUpgradePassword(user, password, db) {
  const stored = user.password || '';
  const isHashed = stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$');

  if (isHashed) {
    return bcrypt.compareSync(password, stored);
  }

  // Legacy plaintext account
  if (stored === password) {
    user.password = bcrypt.hashSync(password, 10);
    writeDB(db);
    return true;
  }
  return false;
}

// 1. Auth: Login
app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const db = readDB();
  const user = db.users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );

  if (!user || !verifyAndUpgradePassword(user, password, db)) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }

  res.json({
    success: true,
    token: issueToken(user),
    user: {
      username: user.username,
      name: user.name,
      role: user.role
    }
  });
});

// 2. Auth: Register
app.post('/api/auth/register', authLimiter, (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name) {
    return res.status(400).json({ error: 'Veuillez remplir tous les champs obligatoires' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
  }

  const db = readDB();
  const userExists = db.users.some(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );

  if (userExists) {
    return res.status(400).json({ error: 'Cet identifiant existe déjà' });
  }

  const newUser = {
    id: String(db.users.length + 1),
    username: username,
    password: bcrypt.hashSync(password, 10),
    name: name,
    role: role || 'user'
  };

  db.users.push(newUser);
  writeDB(db);

  res.json({
    success: true,
    token: issueToken(newUser),
    user: {
      username: newUser.username,
      name: newUser.name,
      role: newUser.role
    }
  });
});

// 3. Claims: Get all
app.get('/api/claims', authenticate, (req, res) => {
  const db = readDB();
  res.json(db.claims);
});

// 4. Claims: Get by ID
app.get('/api/claims/:id', authenticate, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const claim = db.claims.find((c) => c.id === id);
  if (!claim) {
    return res.status(404).json({ error: 'Réclamation introuvable' });
  }
  res.json(claim);
});

// 5. Claims: Create new
app.post('/api/claims', authenticate, (req, res) => {
  const {
    whoAnswered,
    customer,
    plant,
    productReference,
    urgency,
    claimDate,
    officialDate,
    problemDescription,
    incidentLevel,
    okmWarranty,
    user
  } = req.body;

  if (!customer || !plant || !productReference || !claimDate) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }

  const db = readDB();

  // Generate unique claim ID
  // Pattern: 8D-2026-XXXX or Q2026XXXXXX based on standard index
  const nextNum = db.claims.length + 1;
  const year = new Date(claimDate).getFullYear() || 2026;
  const formattedNum = String(nextNum).padStart(4, '0');
  const claimId = `8D-${year}-${formattedNum}`;

  // Calculate deadline based on customer rules (Stellantis 15j, Renault 30j)
  // Stellantis : 15 jours, Renault (et autres) : 30 jours
  const daysToAdd = customer.toLowerCase() === 'stellantis' ? 15 : 30;
  const dateObj = new Date(claimDate);
  const deadlineObj = new Date(dateObj);
  deadlineObj.setDate(deadlineObj.getDate() + daysToAdd);

  const dStr = String(deadlineObj.getDate()).padStart(2, '0');
  const mStr = String(deadlineObj.getMonth() + 1).padStart(2, '0');
  const yStr = deadlineObj.getFullYear();
  const deadlineStr = `${dStr}/${mStr}/${yStr}`;

  // Format claimDate as DD/MM/YYYY for table listing
  const claimDateParts = claimDate.split('-');
  const formattedClaimDate = claimDateParts.length === 3 
    ? `${claimDateParts[2]}/${claimDateParts[1]}/${claimDateParts[0]}`
    : claimDate;

  const newClaim = {
    id: claimId,
    whoAnswered: whoAnswered || 'Non attribué',
    plant: plant,
    customer: customer,
    productReference: productReference,
    urgency: urgency || 'Medium',
    claimDate: formattedClaimDate,
    officialDate: officialDate || '-',
    receptionDateOfProduct: formattedClaimDate,
    deadline: deadlineStr,
    okmWarranty: okmWarranty || 'OKM',
    incidentLevel: incidentLevel || 'A',
    problemDescription: problemDescription || '',
    currentStep: 0,
    status: 'D0 en cours',
    validatedSteps: [],
    history: [
      {
        timestamp: new Date().toISOString(),
        user: user || 'Système',
        action: 'Création de la réclamation'
      }
    ],
    d0: {
      whoAnswered: whoAnswered || 'Non attribué',
      customer: customer,
      plant: plant,
      productReference: productReference,
      urgency: urgency || 'Medium',
      claimDate: formattedClaimDate,
      deadline: deadlineStr,
      officialDate: officialDate || '-',
      daysOpen: 0
    },
    d1: { teamLeader: whoAnswered || '', members: [] },
    d2: { problemDescription: problemDescription || '', riskMatrix: { severity: 1, occurrence: 1, detection: 1 } },
    d3: { nbrBL: '', actions: [] },
    d4: {
      ishikawa: { matiere: [], milieu: [], methode: [], machine: [], mainOeuvre: [], mesure: [] },
      fiveWhys: [
        { path: 'Occurrence', why1: '', why2: '', why3: '', why4: '', why5: '', otherCauses: '', rootCause: '' },
        { path: 'Non-détection', why1: '', why2: '', why3: '', why4: '', why5: '', otherCauses: '', rootCause: '' },
        { path: 'Système', why1: '', why2: '', why3: '', why4: '', why5: '', otherCauses: '', rootCause: '' }
      ]
    },
    d5: { actions: [] },
    d6: { actions: [] },
    d7: { actions: [] },
    d8: { closureDate: '', teamRecognized: false }
  };

  db.claims.push(newClaim);
  writeDB(db);

  res.status(201).json(newClaim);
});

// 6. Claims: Update details (D0-D8)
app.put('/api/claims/:id', authenticate, (req, res) => {
  const { id } = req.params;
  const { stepData, currentStep, validatedSteps, user, actionDescription } = req.body;

  const db = readDB();
  const claimIndex = db.claims.findIndex((c) => c.id === id);

  if (claimIndex === -1) {
    return res.status(404).json({ error: 'Réclamation introuvable' });
  }

  const claim = db.claims[claimIndex];

  // Update specific step details if provided
  if (stepData) {
    // Merge stepData fields into claim (e.g. stepData.d0, stepData.d1, etc.)
    Object.keys(stepData).forEach((key) => {
      claim[key] = { ...claim[key], ...stepData[key] };
    });
  }

  // Update step and validation markers
  if (typeof currentStep !== 'undefined') {
    claim.currentStep = currentStep;
    if (currentStep === 8 && validatedSteps && validatedSteps.includes(8)) {
      claim.status = 'CLOSED';
    } else {
      claim.status = `D${currentStep} en cours`;
    }
  }

  if (validatedSteps) {
    claim.validatedSteps = validatedSteps;
  }

  // Record history of modification with username
  const historyEntry = {
    timestamp: new Date().toISOString(),
    user: user || 'Utilisateur',
    action: actionDescription || 'Mise à jour des informations'
  };
  claim.history.push(historyEntry);

  db.claims[claimIndex] = claim;
  writeDB(db);

  res.json(claim);
});

// 7. Image Upload Endpoint
app.post('/api/upload', authenticate, upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  // Return the relative URL of the uploaded image
  const relativePath = `/uploads/${req.file.filename}`;
  res.json({ success: true, url: relativePath });
});

// 8. Admin: Reset Database (protected by a secret key set in the environment)
app.post('/api/admin/reset', authenticate, (req, res) => {
  if (!ADMIN_RESET_KEY) {
    return res.status(403).json({ error: 'Réinitialisation désactivée : ADMIN_RESET_KEY non configurée sur le serveur' });
  }
  const providedKey = req.headers['x-admin-key'];
  if (providedKey !== ADMIN_RESET_KEY) {
    return res.status(401).json({ error: 'Clé admin invalide' });
  }

  const db = readDB();
  db.claims = []; // Clear claims
  writeDB(db);
  seedDatabase(); // Seed claims again
  res.json({ success: true });
});

// Start the server — bind to 0.0.0.0 so it's reachable on hosting platforms
// (Render, Railway, etc.), not just from the local machine.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
