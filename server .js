const express = require('express');
const session = require('express-session');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const config = {
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    redirectUri: process.env.DISCORD_REDIRECT_URI
  },
  sheets: {
    sheetId: process.env.GOOGLE_SHEET_ID,
    apiKey: process.env.GOOGLE_API_KEY,
    sheetName: process.env.SHEET_NAME || "Info Employé"
  }
};

app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'secret-a-changer',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: true,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'none'
  }
}));

async function getSheetData() {
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.sheets.sheetId}/values/${encodeURIComponent(config.sheets.sheetName)}?key=${config.sheets.apiKey}`;
    const response = await axios.get(url);
    return response.data.values || [];
  } catch (error) {
    console.error('❌ Erreur Google Sheet:', error.message);
    return null;
  }
}

function findHeaderIndex(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].some(cell => 
      cell && (cell.toString().includes("Prénom / Nom") || cell.toString().includes("ID Unique"))
    )) {
      return i;
    }
  }
  return -1;
}

async function findEmployeeByDiscordId(discordId) {
  const data = await getSheetData();
  
  if (!data) {
    console.log('❌ Impossible de récupérer le Sheet');
    return null;
  }

  const headerIndex = findHeaderIndex(data);
  if (headerIndex === -1) {
    console.log('❌ En-tête introuvable');
    return null;
  }

  console.log(`🔍 Recherche ID Discord: ${discordId}`);

  for (let i = headerIndex + 1; i < data.length; i++) {
    const row = data[i];
    const sheetDiscordId = row[6] ? row[6].toString().trim() : '';
    
    if (sheetDiscordId === discordId) {
      console.log('✅ Employé trouvé !');
      
      const employee = {
        nom: row[2] ? row[2].toString().trim() : 'Inconnu',
        grade: row[4] ? row[4].toString().trim() : 'Aucun',
        discordId: sheetDiscordId,
        id: row[1] ? row[1].toString().trim() : '',
        rib: row[3] ? row[3].toString().trim() : '',
        tel: row[5] ? row[5].toString().trim() : '',
        gmail: row[8] ? row[8].toString().trim() : ''
      };
      
      console.log('📋 Grade trouvé:', employee.grade);
      return employee;
    }
  }

  console.log('❌ ID Discord non trouvé');
  return null;
}

function getRoleFromGrade(grade) {
  const gradeUpper = grade.toUpperCase();
  
  if (gradeUpper.includes('PATRON') || gradeUpper.includes('CO PATRON')) {
    return 'admin';
  }
  
  if (gradeUpper.includes('DRH') || gradeUpper.includes('RH')) {
    return 'rh';
  }
  
  if (gradeUpper.includes('RESPONSABLE') || 
      gradeUpper.includes('CHEF') || 
      gradeUpper.includes('CONFIRMÉ') || 
      gradeUpper.includes('MÉCANO') || 
      gradeUpper.includes('APPRENTI') || 
      gradeUpper.includes('STAGIAIRE')) {
    return 'employee';
  }
  
  return 'visitor';
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: 'code',
    scope: 'identify'
  });
  
  console.log('🔗 Redirection Discord OAuth');
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    console.log('❌ Pas de code');
    return res.redirect(`${process.env.FRONTEND_URL}?error=no_code`);
  }
  
  try {
    console.log('🔄 Échange du code...');
    
    const tokenResponse = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: config.discord.redirectUri
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    
    const accessToken = tokenResponse.data.access_token;
    console.log('✅ Token obtenu');
    
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    const discordUser = userResponse.data;
    console.log('✅ User:', discordUser.username, '| ID:', discordUser.id);
    
    const employee = await findEmployeeByDiscordId(discordUser.id);
    
    if (!employee) {
      console.log('❌ Pas dans le Sheet');
      return res.redirect(`${process.env.FRONTEND_URL}?error=not_employee`);
    }
    
    console.log('✅ Employé:', employee.nom, '| Grade:', employee.grade);
    
    const userRole = getRoleFromGrade(employee.grade);
    console.log('✅ Rôle:', userRole);
    
    // IMPORTANT: Stocker TOUTES les infos y compris le grade
    req.session.user = {
      id: discordUser.id,
      username: discordUser.username,
      discriminator: discordUser.discriminator || '0',
      avatar: discordUser.avatar 
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`,
      role: userRole,
      employeeName: employee.nom,
      grade: employee.grade,  // ← GRADE ICI
      employeeId: employee.id,
      rib: employee.rib,
      tel: employee.tel,
      gmail: employee.gmail
    };
    
    console.log('💾 Session créée avec grade:', req.session.user.grade);
    
    req.session.save((err) => {
      if (err) {
        console.error('❌ Erreur session:', err);
        return res.redirect(`${process.env.FRONTEND_URL}?error=session_error`);
      }
      
      console.log('✅ Session sauvegardée !');
      res.redirect(`${process.env.FRONTEND_URL}?auth=success`);
    });
    
  } catch (error) {
    console.error('❌ Erreur OAuth:', error.response?.data || error.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`);
  }
});

app.get('/api/check-auth', (req, res) => {
  console.log('🔍 Check auth');
  if (req.session.user) {
    console.log('✅ Authentifié:', req.session.user.employeeName, '| Grade:', req.session.user.grade);
    res.json({ authenticated: true, user: req.session.user });
  } else {
    console.log('❌ Pas authentifié');
    res.json({ authenticated: false });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Erreur' });
    console.log('👋 Déconnecté');
    res.json({ success: true });
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

app.listen(PORT, () => {
  console.log(`🔥 Paleto Garage Backend - Port ${PORT}`);
});
