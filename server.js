const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const DB_FILE = path.join(DATA_DIR, "inscripciones.json");

for (const dir of [DATA_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]", "utf8");

app.use(express.json());
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(ROOT));
app.get("/", (_, res) => res.sendFile(path.join(ROOT, "index (6).html")));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => {
    const stamp = Date.now();
    const safe = file.originalname.replace(/[^\w.-]/g, "_");
    cb(null, `${stamp}_${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "false") === "true",
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined
});

function readDb() {
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(rows) {
  fs.writeFileSync(DB_FILE, JSON.stringify(rows, null, 2), "utf8");
}

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeFolderName(value) {
  return String(value || "participante")
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function isDriveConfigured() {
  return (
    !!process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID &&
    !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    !!process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  );
}

function createDriveClient() {
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n");
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/drive"]
  });
  return google.drive({ version: "v3", auth });
}

async function createDriveFolder(drive, name, parentId) {
  const result = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId]
    },
    fields: "id,name"
  });
  return result.data;
}

async function setFilePublicRead(drive, fileId) {
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" }
  });
}

async function uploadFileToDrive(drive, file, parentId, makePublic) {
  const uploaded = await drive.files.create({
    requestBody: {
      name: file.originalname,
      mimeType: file.mimetype,
      parents: [parentId]
    },
    media: {
      mimeType: file.mimetype,
      body: fs.createReadStream(file.path)
    },
    fields: "id,name,webViewLink,webContentLink,mimeType"
  });

  if (makePublic) {
    await setFilePublicRead(drive, uploaded.data.id);
  }

  return uploaded.data;
}

async function uploadInscripcionFilesToDrive({ nombre, comprobante, fotos }) {
  if (!isDriveConfigured()) {
    return { enabled: false };
  }

  const drive = createDriveClient();
  const parentId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
  const makePublic = String(process.env.GOOGLE_DRIVE_PUBLIC_LINKS || "false") === "true";

  const participantFolderName = sanitizeFolderName(nombre);
  const participantFolder = await createDriveFolder(drive, participantFolderName, parentId);
  const comprobanteFolder = await createDriveFolder(drive, "comprobante_pago", participantFolder.id);
  const fotosFolder = await createDriveFolder(drive, "fotografias_proyecto", participantFolder.id);

  const comprobanteDriveFile = await uploadFileToDrive(drive, comprobante, comprobanteFolder.id, makePublic);
  const fotosDriveFiles = [];
  for (const foto of fotos) {
    const uploaded = await uploadFileToDrive(drive, foto, fotosFolder.id, makePublic);
    fotosDriveFiles.push(uploaded);
  }

  return {
    enabled: true,
    participantFolder,
    comprobanteFolder,
    fotosFolder,
    comprobanteDriveFile,
    fotosDriveFiles
  };
}

async function sendApprovalEmail(inscripcion) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("SMTP no configurado. Define SMTP_HOST, SMTP_USER y SMTP_PASS.");
  }

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#222">
      <h2>Inscripción Aprobada</h2>
      <p>Hola <strong>${inscripcion.nombre}</strong>,</p>
      <p>Tu inscripción a <strong>FotoFest Colombia 2026</strong> ha sido aprobada.</p>
      <p><strong>Proyecto:</strong> ${inscripcion.titulo}</p>
      <p><strong>ID de inscripción:</strong> ${inscripcion.id}</p>
      <p>Gracias por participar. Pronto te enviaremos información adicional.</p>
    </div>
  `;

  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: inscripcion.email,
    subject: "FotoFest Colombia 2026 · Inscripción aprobada",
    html
  });
}

function canSendEmail() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function sendRegistrationReceivedEmail(inscripcion) {
  if (!canSendEmail()) return;

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#222">
      <h2>Inscripción Recibida</h2>
      <p>Hola <strong>${inscripcion.nombre}</strong>,</p>
      <p>Hemos recibido correctamente tu inscripción a <strong>FotoFest Colombia 2026</strong>.</p>
      <p><strong>Proyecto:</strong> ${inscripcion.titulo}</p>
      <p><strong>ID de inscripción:</strong> ${inscripcion.id}</p>
      <p>Tu estado actual es <strong>pendiente de verificación</strong>. Te avisaremos por correo cuando cambie.</p>
    </div>
  `;

  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: inscripcion.email,
    subject: "FotoFest Colombia 2026 · Inscripción recibida",
    html
  });
}

app.post(
  "/api/inscripciones",
  upload.fields([
    { name: "fotos", maxCount: 50 },
    { name: "comprobante_pago", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const {
        nombre,
        pais,
        email,
        telefono = "",
        titulo,
        categoria,
        num_imagenes,
        texto,
        portfolio = "",
        id_transaccion_paypal,
        correo_paypal_pagador
      } = req.body;

      const fotos = req.files?.fotos || [];
      const comprobante = req.files?.comprobante_pago?.[0];

      if (
        !nombre ||
        !pais ||
        !email ||
        !titulo ||
        !categoria ||
        !num_imagenes ||
        !texto ||
        !id_transaccion_paypal ||
        !correo_paypal_pagador ||
        !comprobante ||
        !fotos.length
      ) {
        return res.status(400).json({ error: "Faltan campos obligatorios o archivos requeridos." });
      }

      const rows = readDb();
      const record = {
        id: createId(),
        createdAt: new Date().toISOString(),
        estado: "pendiente",
        nombre,
        pais,
        email,
        telefono,
        titulo,
        categoria,
        num_imagenes,
        texto,
        portfolio,
        id_transaccion_paypal,
        correo_paypal_pagador,
        comprobante_pago: {
          filename: comprobante.filename,
          originalname: comprobante.originalname,
          path: `/uploads/${comprobante.filename}`
        },
        fotos: fotos.map((f) => ({
          filename: f.filename,
          originalname: f.originalname,
          path: `/uploads/${f.filename}`
        })),
        drive_sync: {
          status: "disabled",
          message: "Google Drive no configurado.",
          syncedAt: null
        }
      };

      if (isDriveConfigured()) {
        try {
          const uploadedToDrive = await uploadInscripcionFilesToDrive({
            nombre,
            comprobante,
            fotos
          });

          if (uploadedToDrive.enabled) {
            record.drive = {
              participante: uploadedToDrive.participantFolder,
              comprobante: uploadedToDrive.comprobanteFolder,
              fotos: uploadedToDrive.fotosFolder
            };
            record.comprobante_pago.drivePath =
              uploadedToDrive.comprobanteDriveFile.webViewLink ||
              uploadedToDrive.comprobanteDriveFile.webContentLink;
            record.comprobante_pago.driveFileId = uploadedToDrive.comprobanteDriveFile.id;

            record.fotos = record.fotos.map((foto, idx) => {
              const driveFile = uploadedToDrive.fotosDriveFiles[idx];
              return {
                ...foto,
                drivePath: driveFile.webViewLink || driveFile.webContentLink,
                driveFileId: driveFile.id
              };
            });

            record.drive_sync = {
              status: "ok",
              message: "Archivos guardados en local y sincronizados con Google Drive.",
              syncedAt: new Date().toISOString()
            };
          }
        } catch (driveError) {
          record.drive_sync = {
            status: "error",
            message: `Se guardo en local pero fallo la sincronizacion a Drive: ${driveError.message}`,
            syncedAt: null
          };
        }
      }

      rows.push(record);
      writeDb(rows);

      // Correo de confirmación de recepción (best effort).
      sendRegistrationReceivedEmail(record).catch(() => {});

      return res.status(201).json({ ok: true, id: record.id, estado: record.estado });
    } catch (error) {
      return res.status(500).json({
        error: `Error al guardar la inscripción: ${error.message || "error desconocido"}.`
      });
    }
  }
);

app.get("/api/inscripciones", (_, res) => {
  const rows = readDb();
  const sorted = rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(sorted);
});

app.patch("/api/inscripciones/:id/estado", async (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;
  if (!["pendiente", "aprobado", "rechazado"].includes(estado)) {
    return res.status(400).json({ error: "Estado inválido." });
  }

  const rows = readDb();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return res.status(404).json({ error: "Inscripción no encontrada." });

  const prev = rows[idx].estado;
  rows[idx].estado = estado;
  rows[idx].updatedAt = new Date().toISOString();

  try {
    if (prev !== "aprobado" && estado === "aprobado") {
      await sendApprovalEmail(rows[idx]);
    }
    writeDb(rows);
    return res.json({ ok: true, estado });
  } catch (error) {
    rows[idx].estado = prev;
    return res.status(500).json({
      error: `No se pudo enviar el correo de confirmación: ${error.message}`
    });
  }
});

app.get("/admin", (_, res) => {
  res.sendFile(path.join(ROOT, "admin.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});
