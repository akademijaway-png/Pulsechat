'use strict';

/**
 * Image uploads: memory buffering, MIME + magic-byte validation,
 * random file names, and safe writes.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { errors } = require('./validate');

const SIGNATURES = {
  'image/jpeg': ['ffd8ff'],
  'image/png': ['89504e470d0a1a0a'],
  'image/webp': ['52494646'], // + WEBP at bytes 8-11, checked below
  'image/gif': ['474946383761', '474946383961'],
};
const EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function sniffMime(buf) {
  for (const [mime, sigs] of Object.entries(SIGNATURES)) {
    for (const sig of sigs) {
      const hex = buf.subarray(0, sig.length / 2).toString('hex');
      if (hex === sig) {
        if (mime === 'image/webp' && buf.subarray(8, 12).toString('ascii') !== 'WEBP') continue;
        return mime;
      }
    }
  }
  return null;
}

function imageUpload(maxBytes) {
  // multer 2.x: multer() returns a factory object — .single('image') is the middleware.
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 5 },
  }).single('image');
}

/** Validate + persist a buffered image. Returns { filename, mime } or null. */
function saveImageBuffer(buffer, destDir) {
  if (!buffer || !buffer.length) return null;
  const mime = sniffMime(buffer);
  if (!mime) return null;
  const filename = crypto.randomUUID() + EXT[mime];
  fs.writeFileSync(path.join(destDir, filename), buffer);
  return { filename, mime };
}

/** Validate + persist a multer file. Throws a clear error on invalid images. */
function saveImageFile(file, destDir) {
  if (!file) throw errors.badRequest('No image was provided.');
  if (!(file.mimetype in SIGNATURES)) {
    throw errors.badRequest('Only JPG, PNG, WEBP or GIF images are allowed.');
  }
  const saved = saveImageBuffer(file.buffer, destDir);
  if (!saved) throw errors.badRequest('The uploaded file does not look like a valid image.');
  return saved;
}

function deleteFileIfExists(absPath) {
  if (!absPath) return;
  try {
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) fs.unlinkSync(absPath);
  } catch (err) {
    console.error('[upload] could not delete old file:', absPath, err.message);
  }
}

module.exports = { imageUpload, saveImageFile, saveImageBuffer, deleteFileIfExists };
