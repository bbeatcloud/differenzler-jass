const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 4000;

let ROOM_CODE = "JASS"; 
let HOST_PASSWORD = "Differenzler-Jass26";

// --- MONGODB ATLAS VERBINDUNG & SCHEMA ---
const MONGO_URI = process.env.MONGO_URI;

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Erfolgreich mit MongoDB Atlas verbunden!'))
    .catch(err => console.error('❌ Fehler bei MongoDB-Verbindung:', err));
} else {
  console.warn('⚠️ Keine MONGO_URI Umgebungsvariable gesetzt. Cloud-Speicherung deaktiviert.');
}

const gameRecordSchema = new mongoose.Schema({
  createdAt: { type: Date, default: Date.now },
  roomCode: { type: String, default: "JASS" },
  players: Object,
  gameState: Object
});

const GameRecord = mongoose.model('GameRecord', gameRecordSchema);

// --- API ENDPUNKTE ---
app.get('/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.post('/api/host/login', (req, res) => {
    const { password } = req.body;
    if (password === HOST_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Falsches Passwort!' });
    }
});

app.post('/api/host/settings', (req, res) => {
    const { currentPassword, newPassword, newRoomCode } = req.body;
    
    if (currentPassword !== HOST_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Das aktuelle Passwort ist falsch!' });
    }

    if (newPassword) {
        if (newPassword.length < 4) {
            return res.status(400).json({ success: false, error: 'Das neue Passwort muss mindestens 4 Zeichen lang sein.' });
        }
        HOST_PASSWORD = newPassword;
    }

    if (newRoomCode) {
        const trimmedCode = newRoomCode.trim().toUpperCase();
        if (trimmedCode.length < 4 || trimmedCode.length > 6) {
            return res.status(400).json({ success: false, error: 'Der Raum-Code muss zwischen 4 und 6 Zeichen lang sein.' });
        }
        ROOM_CODE = trimmedCode;
        io.emit('room_code_updated', ROOM_CODE);
    }

    res.json({ success: true, message: 'Einstellungen erfolgreich aktualisiert!', roomCode: ROOM_CODE });
});

app.post('/api/games/save', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(400).json({ success: false, error: 'Datenbank ist nicht verbunden (MONGO_URI prüfen).' });
        }
        const record = new GameRecord({
            roomCode: ROOM_CODE,
            players: players,
            gameState: gameState
        });
        await record.save();
        res.json({ success: true, message: 'Spielstand erfolgreich in MongoDB gespeichert!' });
    } catch (err) {
        console.error('Fehler beim Speichern in MongoDB:', err);
        res.status(500).json({ success: false, error: 'Speichern fehlgeschlagen: ' + err.message });
    }
});

app.get('/api/games/history', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            console.warn('⚠️ Versuch Historie zu laden, aber MongoDB ist nicht verbunden.');
            return res.status(400).json({ success: false, error: 'Datenbank nicht verbunden. MONGO_URI in Render prüfen!' });
        }
        const games = await GameRecord.find().sort({ createdAt: -1 }).limit(20);
        res.json(games);
    } catch (err) {
        console.error('Fehler beim Abrufen der Historie:', err);
        res.status(500).json({ success: false, error: 'Historie konnte nicht geladen werden: ' + err.message });
    }
});

app.post('/api/games/load/:id', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(400).json({ success: false, error: 'Datenbank ist nicht verbunden.' });
        }
        const gameId = req.params.id;
        const record = await GameRecord.findById(gameId);
        
        if (!record) {
            return res.status(404).json({ success: false, error: 'Spielstand nicht gefunden!' });
        }
        
        gameState = record.gameState;
        players = record.players;
        
        io.emit('players_updated', players);
        io.emit('game_state_updated', gameState);
        
        res.json({ success: true, message: 'Spielstand erfolgreich wiederhergestellt!' });
    } catch (err) {
        console.error('Fehler beim Laden des Spielstands:', err);
        res.status(500).json({ success: false, error: 'Laden fehlgeschlagen' });
    }
});

// --- SPIEL-STATUS ---
let hostState = "Frei"; 
let players = {}; 

function createInitialGameState() {
    return {
        currentPasse: 1,
        currentSpiel: 1,
        matrix: Array.from({ length: 5 }, () => 
            Array.from({ length: 5 }, () => ({
                estimates: { Spieler1: null, Spieler2: null, Spieler3: null, Spieler4: null },
                actual: { Spieler1: null, Spieler2: null, Spieler3: null, Spieler4: null },
                diff: { Spieler1: null, Spieler2: null, Spieler3: null, Spieler4: null },
                hidden: { Spieler1: true, Spieler2: true, Spieler3: true, Spieler4: true },
                cards: {
                    Spieler1: { puur: 0, nell: 0, ass: 0, koenig: 0, dame: 0, bube: 0, zehn: 0, letzter: 0 },
                    Spieler2: { puur: 0, nell: 0, ass: 0, koenig: 0, dame: 0, bube: 0, zehn: 0, letzter: 0 },
                    Spieler3: { puur: 0, nell: 0, ass: 0, koenig: 0, dame: 0, bube: 0, zehn: 0, letzter: 0 },
                    Spieler4: { puur: 0, nell: 0, ass: 0, koenig: 0, dame: 0, bube: 0, zehn: 0, letzter: 0 }
                }
            }))
        )
    };
}

let gameState = createInitialGameState();

function writeLog(playerName, p, s, feld, wert) {
    try {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        
        const logDir = process.platform === 'win32' 
            ? path.join('C:', 'Users', 'Public', 'Documents', 'differenzler-jass', 'Log')
            : path.join(__dirname, 'logs');

        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        const logFileName = `Verdeckter Differenzler_${year}.${month}.${day}.log`;
        const logFilePath = path.join(logDir, logFileName);
        const logLine = `${year}.${month}.${day};${playerName};Passe${p};Spiel${s};${feld};${wert}\n`;
        fs.appendFileSync(logFilePath, logLine, 'utf8');
    } catch (err) {}
}

function getPlayerBySocket(socketId) {
    for (let token in players) {
        if (players[token].socketId === socketId) return players[token];
    }
    return null;
}

io.on('connection', (socket) => {
    socket.emit('init', { hostState, players, gameState, ROOM_CODE });

    socket.on('register_player', ({ name, code, token }) => {
        if (!code || code.trim().toUpperCase() !== ROOM_CODE) {
            return socket.emit('error_msg', 'Falscher Raum-Code!');
        }

        const cleanName = name ? name.trim() : "";
        if (!cleanName) {
            return socket.emit('error_msg', 'Bitte gib einen gültigen Namen ein!');
        }

        if (token && players[token]) {
            players[token].socketId = socket.id;
            players[token].name = cleanName;
            io.emit('players_updated', players);
            return socket.emit('registration_success', { name: cleanName, position: players[token].position, token });
        }

        let existingToken = null;
        for (let t in players) {
            if (players[t].name.toLowerCase() === cleanName.toLowerCase()) {
                existingToken = t;
                break;
            }
        }

        if (existingToken) {
            players[existingToken].socketId = socket.id;
            io.emit('players_updated', players);
            socket.emit('registered_token', existingToken);
            return socket.emit('registration_success', { name: cleanName, position: players[existingToken].position, token: existingToken });
        }

        const activePlayersCount = Object.keys(players).length;
        if (activePlayersCount >= 4) {
            return socket.emit('error_msg', 'Der Tisch ist bereits voll! (Max. 4 Spieler)');
        }

        let usedPositions = Object.values(players).map(p => p.position);
        let position = null;
        for (let i = 1; i <= 4; i++) {
            if (!usedPositions.includes(`Spieler${i}`)) {
                position = `Spieler${i}`;
                break;
            }
        }

        const assignedToken = token || ('token_' + Math.random().toString(36).substring(2) + Date.now().toString(36));
        players[assignedToken] = { name: cleanName, position, socketId: socket.id };
        
        io.emit('players_updated', players);
        socket.emit('registered_token', assignedToken);
        socket.emit('registration_success', { name: cleanName, position, token: assignedToken });
    });

    socket.on('reconnect_with_token', ({ token }) => {
        if (token && players[token]) {
            players[token].socketId = socket.id;
            io.emit('players_updated', players);
            socket.emit('registration_success', { name: players[token].name, position: players[token].position, token });
        }
    });

    socket.on('reset_table', () => {
        players = {};
        gameState = createInitial