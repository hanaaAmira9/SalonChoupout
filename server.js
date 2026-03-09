import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || "./salon.db";

/* =========================
   ADMIN CONFIG
========================= */
const ADMIN_PASSWORD = "admin1234";
const ADMIN_TOKEN = "9f3c1e8a7b2d4f6e91c0a5b8d3e7f1a2";

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Erreur connexion SQLite :", err.message);
  } else {
    console.log("SQLite connecté :", DB_PATH);
  }
});

/* =========================
   HELPERS SQLITE
========================= */
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/* =========================
   HELPERS GÉNÉRAUX
========================= */
function normalizeText(value) {
  return String(value || "").trim();
}

function safeJsonParse(value, fallback = []) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isValidDate(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""));
}

function isValidSlot(time) {
  const allowed = [];
  for (let hour = 9; hour < 19; hour++) {
    allowed.push(`${String(hour).padStart(2, "0")}:00`);
    allowed.push(`${String(hour).padStart(2, "0")}:30`);
  }
  return allowed.includes(String(time));
}

function todayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/* =========================
   AUTH ADMIN
========================= */
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({
      success: false,
      message: "Accès admin refusé."
    });
  }

  next();
}

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};

  if (String(password || "") !== ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: "Mot de passe incorrect."
    });
  }

  return res.json({
    success: true,
    token: ADMIN_TOKEN
  });
});

/* =========================
   INIT DB
========================= */
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      serviceId TEXT NOT NULL,
      serviceName TEXT NOT NULL,
      price INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'Confirmé',
      createdAt TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      duration INTEGER NOT NULL DEFAULT 0,
      description TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      oldPrice INTEGER DEFAULT NULL,
      duration INTEGER NOT NULL DEFAULT 0,
      description TEXT DEFAULT '',
      items TEXT DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS site_content (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_appointments_date_time
    ON appointments(date, time)
  `);

  db.run(`
    INSERT OR IGNORE INTO site_content (key, value) VALUES
    ('hero_title', 'Bienvenue chez votre salon'),
    ('hero_subtitle', 'Réservez votre rendez-vous en quelques clics'),
    ('phone', '+213 000 00 00 00'),
    ('address', 'Votre adresse ici'),
    ('about_title', 'Notre expertise'),
    ('about_text', 'Des services professionnels pour votre style.'),
    ('offers_title', 'Nos packs et offres'),
    ('services_title', 'Nos services')
  `);
});

/* =========================
   SSE NOTIFICATIONS
========================= */
const clients = [];

function broadcastEvent(type, payload) {
  const data = `data: ${JSON.stringify({ type, payload })}\n\n`;

  clients.forEach((client) => {
    try {
      client.res.write(data);
    } catch (error) {
      console.error("Erreur SSE :", error.message);
    }
  });
}

app.get("/api/notifications/stream", (req, res) => {
  const token = req.query.token || "";

  if (token !== ADMIN_TOKEN) {
    return res.status(401).end();
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const clientId = Date.now() + Math.random();
  const client = { id: clientId, res };
  clients.push(client);

  res.write(`data: ${JSON.stringify({ type: "connected", payload: null })}\n\n`);

  req.on("close", () => {
    const index = clients.findIndex((c) => c.id === clientId);
    if (index !== -1) {
      clients.splice(index, 1);
    }
  });
});

/* =========================
   APPOINTMENTS
========================= */
app.get("/api/appointments", requireAdmin, async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT *
      FROM appointments
      ORDER BY date ASC, time ASC
    `);

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur chargement rendez-vous."
    });
  }
});

app.post("/api/appointments", async (req, res) => {
  try {
    const data = req.body;

    const requiredFields = [
      "id",
      "name",
      "phone",
      "serviceId",
      "serviceName",
      "date",
      "time"
    ];

    for (const field of requiredFields) {
      if (!normalizeText(data[field])) {
        return res.status(400).json({
          success: false,
          message: `Champ obligatoire manquant : ${field}`
        });
      }
    }

    if (!isValidDate(data.date)) {
      return res.status(400).json({
        success: false,
        message: "Date invalide."
      });
    }

    if (!isValidSlot(data.time)) {
      return res.status(400).json({
        success: false,
        message: "Créneau invalide."
      });
    }

    const today = todayDateString();
    if (String(data.date) < today) {
      return res.status(400).json({
        success: false,
        message: "Impossible de réserver dans le passé."
      });
    }

    const existing = await getQuery(
      `SELECT id FROM appointments WHERE date = ? AND time = ?`,
      [data.date, data.time]
    );

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Ce créneau est déjà réservé."
      });
    }

    await runQuery(
      `
      INSERT INTO appointments (
        id, name, phone, serviceId, serviceName,
        price, duration, date, time, notes, status, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        normalizeText(data.id),
        normalizeText(data.name),
        normalizeText(data.phone),
        normalizeText(data.serviceId),
        normalizeText(data.serviceName),
        Number(data.price || 0),
        Number(data.duration || 0),
        normalizeText(data.date),
        normalizeText(data.time),
        normalizeText(data.notes),
        normalizeText(data.status) || "Confirmé",
        data.createdAt || new Date().toISOString()
      ]
    );

    const createdAppointment = await getQuery(
      `SELECT * FROM appointments WHERE id = ?`,
      [data.id]
    );

    broadcastEvent("new_appointment", createdAppointment);

    res.status(201).json({
      success: true,
      message: "Rendez-vous enregistré avec succès.",
      appointment: createdAppointment
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de l'enregistrement."
    });
  }
});

app.delete("/api/appointments/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await getQuery(
      `SELECT id FROM appointments WHERE id = ?`,
      [id]
    );

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Rendez-vous introuvable."
      });
    }

    await runQuery(`DELETE FROM appointments WHERE id = ?`, [id]);

    broadcastEvent("appointment_deleted", { id });

    res.json({
      success: true,
      message: "Rendez-vous supprimé."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur suppression."
    });
  }
});

app.patch("/api/appointments/:id/done", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await getQuery(
      `SELECT id FROM appointments WHERE id = ?`,
      [id]
    );

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Rendez-vous introuvable."
      });
    }

    await runQuery(
      `UPDATE appointments SET status = 'Terminé' WHERE id = ?`,
      [id]
    );

    const updated = await getQuery(
      `SELECT * FROM appointments WHERE id = ?`,
      [id]
    );

    broadcastEvent("appointment_done", updated);

    res.json({
      success: true,
      message: "Rendez-vous marqué comme terminé.",
      appointment: updated
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur mise à jour."
    });
  }
});

/* =========================
   SERVICES
========================= */
app.get("/api/services", requireAdmin, async (req, res) => {
  try {
    const onlyActive = req.query.active === "1";

    let sql = `SELECT * FROM services`;
    const params = [];

    if (onlyActive) {
      sql += ` WHERE active = ?`;
      params.push(1);
    }

    sql += ` ORDER BY createdAt DESC`;

    const rows = await allQuery(sql, params);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur chargement services."
    });
  }
});

app.post("/api/services", requireAdmin, async (req, res) => {
  try {
    const data = req.body;

    if (!normalizeText(data.id) || !normalizeText(data.name)) {
      return res.status(400).json({
        success: false,
        message: "ID et nom du service sont obligatoires."
      });
    }

    await runQuery(
      `
      INSERT INTO services (
        id, name, price, duration, description, active, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        normalizeText(data.id),
        normalizeText(data.name),
        Number(data.price || 0),
        Number(data.duration || 0),
        normalizeText(data.description),
        Number(data.active) === 0 ? 0 : 1,
        new Date().toISOString()
      ]
    );

    res.status(201).json({
      success: true,
      message: "Service ajouté avec succès."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur création service."
    });
  }
});

app.put("/api/services/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;

    const existing = await getQuery(`SELECT id FROM services WHERE id = ?`, [id]);

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Service introuvable."
      });
    }

    await runQuery(
      `
      UPDATE services
      SET name = ?, price = ?, duration = ?, description = ?, active = ?
      WHERE id = ?
      `,
      [
        normalizeText(data.name),
        Number(data.price || 0),
        Number(data.duration || 0),
        normalizeText(data.description),
        Number(data.active) === 0 ? 0 : 1,
        id
      ]
    );

    res.json({
      success: true,
      message: "Service mis à jour."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur mise à jour service."
    });
  }
});

app.delete("/api/services/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await getQuery(`SELECT id FROM services WHERE id = ?`, [id]);

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Service introuvable."
      });
    }

    await runQuery(`DELETE FROM services WHERE id = ?`, [id]);

    res.json({
      success: true,
      message: "Service supprimé."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur suppression service."
    });
  }
});

/* =========================
   OFFERS / PACKS
========================= */
app.get("/api/offers", requireAdmin, async (req, res) => {
  try {
    const onlyActive = req.query.active === "1";

    let sql = `SELECT * FROM offers`;
    const params = [];

    if (onlyActive) {
      sql += ` WHERE active = ?`;
      params.push(1);
    }

    sql += ` ORDER BY createdAt DESC`;

    const rows = await allQuery(sql, params);

    const parsed = rows.map((item) => ({
      ...item,
      items: safeJsonParse(item.items || "[]", [])
    }));

    res.json(parsed);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur chargement offres."
    });
  }
});

app.post("/api/offers", requireAdmin, async (req, res) => {
  try {
    const data = req.body;

    if (!normalizeText(data.id) || !normalizeText(data.title)) {
      return res.status(400).json({
        success: false,
        message: "ID et titre sont obligatoires."
      });
    }

    await runQuery(
      `
      INSERT INTO offers (
        id, title, price, oldPrice, duration, description, items, active, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        normalizeText(data.id),
        normalizeText(data.title),
        Number(data.price || 0),
        data.oldPrice !== undefined && data.oldPrice !== null && data.oldPrice !== ""
          ? Number(data.oldPrice)
          : null,
        Number(data.duration || 0),
        normalizeText(data.description),
        JSON.stringify(Array.isArray(data.items) ? data.items : []),
        Number(data.active) === 0 ? 0 : 1,
        new Date().toISOString()
      ]
    );

    res.status(201).json({
      success: true,
      message: "Offre ajoutée avec succès."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur création offre."
    });
  }
});

app.put("/api/offers/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;

    const existing = await getQuery(`SELECT id FROM offers WHERE id = ?`, [id]);

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Offre introuvable."
      });
    }

    await runQuery(
      `
      UPDATE offers
      SET title = ?, price = ?, oldPrice = ?, duration = ?, description = ?, items = ?, active = ?
      WHERE id = ?
      `,
      [
        normalizeText(data.title),
        Number(data.price || 0),
        data.oldPrice !== undefined && data.oldPrice !== null && data.oldPrice !== ""
          ? Number(data.oldPrice)
          : null,
        Number(data.duration || 0),
        normalizeText(data.description),
        JSON.stringify(Array.isArray(data.items) ? data.items : []),
        Number(data.active) === 0 ? 0 : 1,
        id
      ]
    );

    res.json({
      success: true,
      message: "Offre mise à jour."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur mise à jour offre."
    });
  }
});

app.delete("/api/offers/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await getQuery(`SELECT id FROM offers WHERE id = ?`, [id]);

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Offre introuvable."
      });
    }

    await runQuery(`DELETE FROM offers WHERE id = ?`, [id]);

    res.json({
      success: true,
      message: "Offre supprimée."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur suppression offre."
    });
  }
});

/* =========================
   SITE CONTENT
========================= */
app.get("/api/site-content", requireAdmin, async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT key, value
      FROM site_content
      ORDER BY key ASC
    `);

    const content = {};
    for (const row of rows) {
      content[row.key] = row.value;
    }

    res.json(content);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur chargement contenu site."
    });
  }
});

app.put("/api/site-content", requireAdmin, async (req, res) => {
  try {
    const data = req.body;

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return res.status(400).json({
        success: false,
        message: "Format invalide."
      });
    }

    const entries = Object.entries(data);

    for (const [key, value] of entries) {
      await runQuery(
        `
        INSERT INTO site_content (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        [normalizeText(key), String(value ?? "")]
      );
    }

    res.json({
      success: true,
      message: "Contenu du site mis à jour."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur mise à jour contenu site."
    });
  }
});

/* =========================
   SITE DATA PUBLIC
========================= */
app.get("/api/site-data", async (req, res) => {
  try {
    const services = await allQuery(`
      SELECT *
      FROM services
      WHERE active = 1
      ORDER BY createdAt DESC
    `);

    const offersRaw = await allQuery(`
      SELECT *
      FROM offers
      WHERE active = 1
      ORDER BY createdAt DESC
    `);

    const offers = offersRaw.map((item) => ({
      ...item,
      items: safeJsonParse(item.items || "[]", [])
    }));

    const contentRows = await allQuery(`
      SELECT key, value
      FROM site_content
    `);

    const content = {};
    for (const row of contentRows) {
      content[row.key] = row.value;
    }

    res.json({
      success: true,
      services,
      offers,
      content
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Erreur chargement site."
    });
  }
});

/* =========================
   HEALTHCHECK
========================= */
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "API salon active"
  });
});

app.listen(PORT, () => {
  console.log(`Backend salon lancé sur http://localhost:${PORT}`);
});
