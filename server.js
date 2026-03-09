import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database("./salon.db");

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
});

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

function isValidSlot(time) {
  const allowed = [];
  for (let hour = 9; hour < 19; hour++) {
    allowed.push(`${String(hour).padStart(2, "0")}:00`);
    allowed.push(`${String(hour).padStart(2, "0")}:30`);
  }
  return allowed.includes(time);
}

app.get("/api/appointments", async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT *
      FROM appointments
      ORDER BY date ASC, time ASC
    `);

    res.json(rows);
  } catch (error) {
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
      if (!String(data[field] || "").trim()) {
        return res.status(400).json({
          success: false,
          message: `Champ obligatoire manquant : ${field}`
        });
      }
    }

    const selectedDate = new Date(`${data.date}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (selectedDate < today) {
      return res.status(400).json({
        success: false,
        message: "Impossible de réserver dans le passé."
      });
    }

    if (!isValidSlot(String(data.time))) {
      return res.status(400).json({
        success: false,
        message: "Créneau invalide."
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
        data.id,
        data.name,
        data.phone,
        data.serviceId,
        data.serviceName,
        Number(data.price || 0),
        Number(data.duration || 0),
        data.date,
        data.time,
        data.notes || "",
        data.status || "Confirmé",
        data.createdAt || new Date().toISOString()
      ]
    );

    res.status(201).json({
      success: true,
      message: "Rendez-vous enregistré avec succès."
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erreur lors de l'enregistrement."
    });
  }
});

app.delete("/api/appointments/:id", async (req, res) => {
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

    res.json({
      success: true,
      message: "Rendez-vous supprimé."
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erreur suppression."
    });
  }
});

app.patch("/api/appointments/:id/done", async (req, res) => {
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

    res.json({
      success: true,
      message: "Rendez-vous marqué comme terminé."
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erreur mise à jour."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend salon lancé sur http://localhost:${PORT}`);
});
