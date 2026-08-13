const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'mysecretpassword',
    database: process.env.DB_NAME || 'text_analyzer'
});

const initDb = async (retries = 5) => {
    while (retries) {
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(50) UNIQUE NOT NULL,
                    email VARCHAR(100) UNIQUE NOT NULL,
                    password VARCHAR(255) NOT NULL,
                    role VARCHAR(20) DEFAULT 'user',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Ensure role column exists on older installations
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';`);

            await pool.query(`
                CREATE TABLE IF NOT EXISTS history (
                    id SERIAL PRIMARY KEY,
                    user_id INT NOT NULL,
                    text TEXT NOT NULL,
                    word_count INT,
                    char_count INT,
                    vowel_count INT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
            `);

            console.log("PostgreSQL 17 Schema initialized: 'users' and 'history' tables ready.");
            break;
        } catch (err) {
            console.log(`Database not ready, retrying in 3s... (${retries} retries left)`);
            retries -= 1;
            await new Promise(res => setTimeout(res, 3000));
        }
    }
};

initDb();

const isAdmin = async (userId) => {
    if (!userId) return false;
    try {
        const res = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
        return res.rows.length > 0 && res.rows[0].role === 'admin';
    } catch {
        return false;
    }
};

// INSCRIPTION
app.post('/api/register', async (req, res) => {
    const { username, email, password, adminCode } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Tous les champs (nom, email, mot de passe) sont requis.' });
    }

    const role = (adminCode && process.env.ADMIN_CODE && adminCode === process.env.ADMIN_CODE) ? 'admin' : 'user';

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, username, email, role',
            [username, email, hashedPassword, role]
        );
        res.status(201).json({ message: 'Compte créé avec succès !', user: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Le nom d utilisateur ou l email existe déjà.' });
        }
        res.status(500).json({ error: 'Erreur serveur lors de l inscription.' });
    }
});

// CONNEXION
app.post('/api/login', async (req, res) => {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
        return res.status(400).json({ error: 'Veuillez remplir tous les champs.' });
    }

    try {
        const userQuery = await pool.query(
            'SELECT * FROM users WHERE username = $1 OR email = $1',
            [identifier]
        );
        if (userQuery.rows.length === 0) {
            return res.status(400).json({ error: 'Identifiant ou mot de passe incorrect.' });
        }

        const user = userQuery.rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Identifiant ou mot de passe incorrect.' });
        }

        res.json({
            message: 'Connexion réussie',
            user: { id: user.id, username: user.username, email: user.email, role: user.role }
        });
    } catch (err) {
        res.status(500).json({ error: 'Erreur serveur lors de la connexion.' });
    }
});

// ANALYSE DE TEXTE
app.post('/api/analyze', async (req, res) => {
    const { text = '', user_id } = req.body;

    if (!user_id) {
        return res.status(400).json({ error: 'Utilisateur non identifié.' });
    }

    const charCount = text.length;
    const wordCount = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    const vowelCount = (text.match(/[aeiouyàâéèêëîïôûùüÿæœ]/gi) || []).length;

    try {
        await pool.query(
            'INSERT INTO history (user_id, text, word_count, char_count, vowel_count) VALUES ($1, $2, $3, $4, $5)',
            [user_id, text, wordCount, charCount, vowelCount]
        );
        res.json({ characters: charCount, words: wordCount, vowels: vowelCount });
    } catch (err) {
        console.error("Database insertion error:", err);
        res.status(500).json({ error: 'Erreur lors de l enregistrement dans l historique.' });
    }
});

// HISTORIQUE
app.get('/api/history/:userId', async (req, res) => {
    const { userId } = req.params;
    const requesterId = req.query.requesterId;

    try {
        const allowed = (parseInt(requesterId) === parseInt(userId)) || (await isAdmin(requesterId));
        if (!allowed) return res.status(403).json({ error: 'Accès refusé.' });

        const history = await pool.query(
            'SELECT id, user_id, text, word_count, char_count, vowel_count, created_at FROM history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
            [userId]
        );
        res.json(history.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erreur lors de la récupération de l historique.' });
    }
});

// UTILISATEURS (ADMIN)
app.get('/api/users', async (req, res) => {
    const requesterId = req.query.requesterId;
    if (!(await isAdmin(requesterId))) {
        return res.status(403).json({ error: 'Accès refusé. Réservé aux administrateurs.' });
    }

    try {
        const users = await pool.query('SELECT id, username, email, role FROM users ORDER BY username');
        res.json(users.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erreur lors de la récupération des utilisateurs.' });
    }
});

// MODIFIER HISTORIQUE
app.put('/api/history/:id', async (req, res) => {
    const { id } = req.params;
    const { text, requesterId } = req.body;

    try {
        const row = await pool.query('SELECT user_id FROM history WHERE id = $1', [id]);
        if (row.rows.length === 0) return res.status(404).json({ error: 'Entrée introuvable.' });
        
        const ownerId = row.rows[0].user_id;
        const allowed = (parseInt(ownerId) === parseInt(requesterId)) || (await isAdmin(requesterId));
        if (!allowed) return res.status(403).json({ error: 'Accès refusé.' });

        const charCount = text.length;
        const wordCount = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
        const vowelCount = (text.match(/[aeiouyàâéèêëîïôûùüÿæœ]/gi) || []).length;

        await pool.query(
            'UPDATE history SET text = $1, word_count = $2, char_count = $3, vowel_count = $4 WHERE id = $5',
            [text, wordCount, charCount, vowelCount, id]
        );

        res.json({ id, text, word_count: wordCount, char_count: charCount, vowel_count: vowelCount });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erreur lors de la mise à jour de l historique.' });
    }
});

// SUPPRIMER HISTORIQUE
app.delete('/api/history/:id', async (req, res) => {
    const { id } = req.params;
    const requesterId = req.query.requesterId;

    try {
        const row = await pool.query('SELECT user_id FROM history WHERE id = $1', [id]);
        if (row.rows.length === 0) return res.status(404).json({ error: 'Entrée introuvable.' });
        
        const ownerId = row.rows[0].user_id;
        const allowed = (parseInt(ownerId) === parseInt(requesterId)) || (await isAdmin(requesterId));
        if (!allowed) return res.status(403).json({ error: 'Accès refusé.' });

        await pool.query('DELETE FROM history WHERE id = $1', [id]);
        res.json({ message: 'Supprimé.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erreur lors de la suppression de l historique.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});