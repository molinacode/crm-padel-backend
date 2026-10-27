const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { requireUser } = require('./session');

const BUCKET = 'fotos-alumnos';
const CARTEL_BUCKET = 'carteles-eventos';

function fotosDir() {
  return process.env.FOTOS_DIR || path.join(__dirname, '..', 'data', 'fotos-alumnos');
}

/** Dentro del volumen de fotos para persistir en Coolify sin montaje extra. */
function cartelesDir() {
  return (
    process.env.CARTELES_DIR || path.join(fotosDir(), 'carteles-eventos')
  );
}

function ensureDir() {
  fs.mkdirSync(fotosDir(), { recursive: true });
  fs.mkdirSync(cartelesDir(), { recursive: true });
}

function safeName(name) {
  return String(name || 'foto')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 180);
}

// Para leer/borrar no se reescribe el nombre: las fotos migradas de Supabase
// conservan el suyo y `safeName` las dejaría fuera. Solo se corta el traspaso
// de directorio.
function resolveExisting(name) {
  const limpio = String(name || '');
  if (!limpio || limpio.includes('/') || limpio.includes('\\') || limpio.includes('..')) {
    return null;
  }
  const dir = fotosDir();
  const file = path.join(dir, limpio);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return null;
  return file;
}

const TIPOS_PERMITIDOS = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir();
      cb(null, fotosDir());
    },
    filename: (req, file, cb) => {
      cb(null, safeName(req.params.filename || file.originalname));
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_PERMITIDOS.has(file.mimetype)) {
      cb(new Error('Solo se admiten imágenes (jpeg, png, webp, gif, avif)'));
      return;
    }
    cb(null, true);
  },
});

// Las fotos se guardan sin extensión (tanto las nuevas como las migradas de
// Supabase), así que el tipo se deduce de la cabecera del fichero. Sin esto se
// sirven sin Content-Type y el navegador tiene que adivinarlo.
function tipoPorFirma(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
    if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      return 'image/png';
    if (head.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
    if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP')
      return 'image/webp';
    if (head.subarray(4, 8).toString('latin1') === 'ftyp') return 'image/avif';
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function publicUrl(filename) {
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  return `${base}/${BUCKET}/${encodeURIComponent(filename)}`;
}

function cartelPublicUrl(filename) {
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  return `${base}/api/public/carteles/${encodeURIComponent(filename)}`;
}

function resolveCartel(name) {
  const limpio = String(name || '');
  if (!limpio || limpio.includes('/') || limpio.includes('\\') || limpio.includes('..')) {
    return null;
  }
  const dir = cartelesDir();
  const file = path.join(dir, limpio);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return null;
  return file;
}

const uploadCartel = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir();
      cb(null, cartelesDir());
    },
    filename: (_req, file, cb) => {
      const ext =
        file.mimetype === 'image/png'
          ? '.png'
          : file.mimetype === 'image/webp'
            ? '.webp'
            : file.mimetype === 'image/gif'
              ? '.gif'
              : '.jpg';
      const stamp = Date.now().toString(36);
      cb(null, `cartel-${stamp}-${safeName(file.originalname).replace(/\.[^.]+$/, '')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_PERMITIDOS.has(file.mimetype)) {
      cb(new Error('Solo se admiten imágenes (jpeg, png, webp, gif, avif)'));
      return;
    }
    cb(null, true);
  },
});

function mountStorage(app) {
  ensureDir();

  app.get(`/${BUCKET}/:filename`, requireUser, (req, res) => {
    const file = resolveExisting(req.params.filename);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return res.status(404).end();
    }
    const tipo = tipoPorFirma(file);
    res.sendFile(file, {
      headers: {
        'Content-Type': tipo || 'application/octet-stream',
        'Content-Disposition': tipo ? 'inline' : 'attachment',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });

  // Carteles de eventos: públicos (landing).
  app.get(`/api/public/carteles/:filename`, (req, res) => {
    const file = resolveCartel(req.params.filename);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return res.status(404).end();
    }
    const tipo = tipoPorFirma(file);
    res.sendFile(file, {
      headers: {
        'Content-Type': tipo || 'application/octet-stream',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  });

  app.post(
    `/api/storage/${BUCKET}/:filename`,
    requireUser,
    (req, res, next) => {
      upload.single('file')(req, res, err => {
        if (err) return res.status(400).json({ error: err.message });
        next();
      });
    },
    (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Sin archivo' });
      if (!tipoPorFirma(req.file.path)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'El archivo no es una imagen válida' });
      }
      res.json({ path: req.file.filename, publicUrl: publicUrl(req.file.filename) });
    }
  );

  app.delete(`/api/storage/${BUCKET}/:filename`, requireUser, (req, res) => {
    const file = resolveExisting(req.params.filename);
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) fs.unlinkSync(file);
    res.json({ ok: true });
  });
}

module.exports = {
  mountStorage,
  publicUrl,
  cartelPublicUrl,
  uploadCartel,
  resolveCartel,
  cartelesDir,
  BUCKET,
  CARTEL_BUCKET,
};
