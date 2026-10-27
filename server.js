const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// JSON Parsing für API Endpunkte aktivieren
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

// --- API ENDPUNKTE FÜR DIE HISTORIE & CONFIG ---
app.get('/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

// Passwort prüfen
app.post('/api/host/login', (req, res) => {
    const { password } = req.body;
    if (password === HOST_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Falsches Passwort!' });
    }
});

// Einstellungen aktualisieren
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

// Spielstand manuell oder automatisch in MongoDB speichern
app.post('/api/games/save', async (req, res) => {
    try {
        const record = new GameRecord({
            roomCode: ROOM_CODE,
            players: players,
            gameState: gameState
        });
        await record.save();
        res.json({ success: true, message: 'Spielstand erfolgreich in MongoDB gespeichert!' });
    } catch (err) {
        console.error('Fehler beim Speichern in MongoDB:', err);
        res.status(500).json({ success: false, error: 'Speichern fehlgeschlagen' });
    }
});

// Die letzten gespielten Partien auslesen (Einfach & sauber, ohne Duplikate)
app.get('/api/games/history', async (req, res) => {
    try {
        const games = await GameRecord.find().sort({ createdAt: -1 }).limit(20);
        res.json(games);
    } catch (err) {
        console.error('Fehler beim Abrufen der Historie:', err);
        res.status(500).json({ success: false, error: 'Historie konnte nicht geladen werden' });
    }
});

// Einen spezifischen Spielstand aus der Historie laden und wiederherstellen
app.post('/api/games/load/:id', async (req, res) => {
    try {
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

// --- SPIEL-STATUS & VARIABLEN ---
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
        gameState = createInitialGameState();
        io.emit('players_updated', players);
        io.emit('game_state_updated', gameState);
    });

    socket.on('toggle_host', (state) => {
        hostState = state;
        io.emit('host_state_changed', hostState);
    });

    socket.on('submit_estimate', ({ estimate }) => {
        if (hostState === "Sperren") return;
        const player = getPlayerBySocket(socket.id);
        if (!player) return;

        const p = gameState.currentPasse;
        const s = gameState.currentSpiel;
        const pos = player.position;

        const parsedEst = parseInt(estimate);
        if (isNaN(parsedEst) || parsedEst < 0 || parsedEst > 157) return;

        gameState.matrix[p][s].estimates[pos] = parsedEst;
        gameState.matrix[p][s].hidden[pos] = true;
        writeLog(player.name, p, s, "Gesch.", parsedEst);

        io.emit('game_state_updated', gameState);
    });

    socket.on('submit_actual', ({ actual, cards }) => {
        if (hostState === "Sperren") return;
        const player = getPlayerBySocket(socket.id);
        if (!player) return;

        const p = gameState.currentPasse;
        const s = gameState.currentSpiel;
        const pos = player.position;

        const parsedActual = parseInt(actual);
        if (isNaN(parsedActual) || parsedActual < 0 || parsedActual > 157) {
            return socket.emit('error_msg', 'Ungültige Punktzahl!');
        }

        let tempSum = parsedActual;
        for (let otherPos of ['Spieler1', 'Spieler2', 'Spieler3', 'Spieler4']) {
            if (otherPos !== pos && gameState.matrix[p][s].actual[otherPos] !== null) {
                tempSum += gameState.matrix[p][s].actual[otherPos];
            }
        }

        if (tempSum > 157) {
            return socket.emit('error_msg', `Fehler: Die Gesamtsumme darf 157 nicht überschreiten! (Aktuell: ${tempSum})`);
        }

        const cardLimits = { puur: 1, nell: 1, ass: 4, koenig: 4, dame: 4, bube: 3, zehn: 4, letzter: 1 };
        
        for (let cardKey in cardLimits) {
            let usedByOthers = 0;
            for (let otherPos of ['Spieler1', 'Spieler2', 'Spieler3', 'Spieler4']) {
                if (otherPos !== pos) {
                    usedByOthers += gameState.matrix[p][s].cards[otherPos][cardKey] || 0;
                }
            }
            let requested = parseInt(cards[cardKey]) || 0;
            if (usedByOthers + requested > cardLimits[cardKey]) {
                return socket.emit('error_msg', `Fehler: Die Karte '${cardKey}' wurde insgesamt zu oft vergeben!`);
            }
        }

        gameState.matrix[p][s].cards[pos] = cards;
        gameState.matrix[p][s].actual[pos] = parsedActual;
        writeLog(player.name, p, s, "Spiel.", parsedActual);

        const est = gameState.matrix[p][s].estimates[pos] !== null ? gameState.matrix[p][s].estimates[pos] : 0;
        const diff = Math.abs(est - parsedActual);
        gameState.matrix[p][s].diff[pos] = diff;
        writeLog(player.name, p, s, "Diff.", diff);

        gameState.matrix[p][s].hidden[pos] = false;

        let count = 0;
        let sumAct = 0;
        for(let k of ['Spieler1','Spieler2','Spieler3','Spieler4']) {
            if(gameState.matrix[p][s].actual[k] !== null) {
                count++;
                sumAct += gameState.matrix[p][s].actual[k];
            }
        }

        if (count === 4 && sumAct === 157) {
            if (s === 4) {
                for (let token in players) {
                    let pl = players[token];
                    let totalDiffPasse = 0;
                    for(let i=1; i<=4; i++) totalDiffPasse += gameState.matrix[p][i].diff[pl.position] || 0;
                    writeLog(pl.name, p, "Gesamt", "Diff.", totalDiffPasse);
                }

                if (MONGO_URI) {
                    new GameRecord({ roomCode: ROOM_CODE, players, gameState }).save()
                        .then(() => console.log('☁️ Passe automatisch in MongoDB gespeichert.'))
                        .catch(e => console.error('Fehler beim Autosave:', e));
                }
            }

            if (gameState.currentSpiel < 4) {
                gameState.currentSpiel++;
            } else if (gameState.currentPasse < 4) {
                gameState.currentPasse++;
                gameState.currentSpiel = 1;
            }
        }

        io.emit('game_state_updated', gameState);
    });

    socket.on('next_step', () => {
        if (gameState.currentSpiel < 4) {
            gameState.currentSpiel++;
        } else if (gameState.currentPasse < 4) {
            gameState.currentPasse++;
            gameState.currentSpiel = 1;
        }
        io.emit('game_state_updated', gameState);
    });

    socket.on('disconnect', () => {
        for (let token in players) {
            if (players[token].socketId === socket.id) {
                players[token].socketId = null; 
            }
        }
        io.emit('players_updated', players);
    });
});

server.listen(PORT, '0.0.0.0', () => { 
    console.log(`Server läuft auf Port ${PORT}`); 
});