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
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

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

// INSCRIPTION
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Tous les champs (nom, email, mot de passe) sont requis.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id, username, email',
            [username, email, hashedPassword]
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
            user: { id: user.id, username: user.username, email: user.email }
        });
    } catch (err) {
        res.status(500).json({ error: 'Erreur serveur lors de la connexion.' });
    }
});


app.post('/api/analyze', async (req, res) => {
    const { text = '', user_id } = req.body;

    if (!user_id) {
        return res.status(401).json({ error: 'Vous devez être connecté pour effectuer une analyse.' });
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

// OBTENIR L'HISTORIQUE DE L'UTILISATEUR
app.get('/api/history/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const history = await pool.query(
            'SELECT id, text, word_count, char_count, vowel_count, created_at FROM history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
            [userId]
        );
        res.json(history.rows);
    } catch (err) {
        res.status(500).json({ error: 'Erreur lors de la récupération de l historique.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});