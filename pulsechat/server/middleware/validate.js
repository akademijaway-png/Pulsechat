'use strict';

/**
 * Small validation / error-handling toolkit.
 * Every API error returns a stable machine `error` code plus a human `message`,
 * so the client can show clear, specific errors (login failed, user not found…).
 */

class HttpError extends Error {
  constructor(status, error, message, details) {
    super(message);
    this.status = status;
    this.error = error;
    this.details = details;
  }
}

const errors = {
  badRequest: (msg, details) => new HttpError(400, 'bad_request', msg, details),
  unauthorized: (msg) => new HttpError(401, 'unauthorized', msg || 'Authentication required.'),
  forbidden: (msg) => new HttpError(403, 'forbidden', msg || 'You are not allowed to do that.'),
  notFound: (msg) => new HttpError(404, 'not_found', msg || 'Not found.'),
  conflict: (msg) => new HttpError(409, 'conflict', msg),
  unprocessable: (msg, details) => new HttpError(422, 'validation_error', msg, details),
  tooMany: (msg) => new HttpError(429, 'rate_limited', msg || 'Too many requests. Please slow down.'),
  server: (msg) => new HttpError(500, 'internal_error', msg || 'Something went wrong on our side.'),
};

/* ---------------- validators ---------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);
}

/** Reasonable password policy: >= 8 chars with at least one letter and one digit. */
function passwordIssue(value) {
  if (typeof value !== 'string' || value.length < 8) return 'Password must be at least 8 characters.';
  if (value.length > 128) return 'Password must be at most 128 characters.';
  if (!/[A-Za-z]/.test(value)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(value)) return 'Password must contain at least one number.';
  return null;
}

function requireString(value, field, { min = 1, max = 1000 } = {}) {
  if (typeof value !== 'string') throw errors.unprocessable(`${field} is required.`);
  const v = value.trim();
  if (v.length < min) throw errors.unprocessable(`${field} must be at least ${min} character${min === 1 ? '' : 's'}.`);
  if (v.length > max) throw errors.unprocessable(`${field} must be at most ${max} characters.`);
  return v;
}

/** Validate a JSON body strictly — unknown/malformed shapes are rejected. */
function validateBody(schema) {
  return (req, res, next) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return next(errors.badRequest('Request body must be a JSON object.'));
    }
    const out = {};
    for (const [field, rule] of Object.entries(schema)) {
      const value = body[field];
      if (value === undefined || value === null) {
        if (rule.required) return next(errors.unprocessable(`${rule.label || field} is required.`));
        continue;
      }
      if (rule.type === 'string') {
        try {
          out[field] = requireString(value, rule.label || field, rule);
        } catch (e) {
          return next(e);
        }
        if (rule.pattern && !rule.pattern.test(out[field])) {
          return next(errors.unprocessable(rule.patternMessage || `${rule.label || field} is invalid.`));
        }
      } else if (rule.type === 'boolean') {
        if (typeof value !== 'boolean') return next(errors.unprocessable(`${rule.label || field} must be a boolean.`));
        out[field] = value;
      } else if (rule.type === 'integer') {
        if (!Number.isInteger(value)) return next(errors.unprocessable(`${rule.label || field} must be a whole number.`));
        out[field] = value;
      }
    }
    req.valid = out;
    next();
  };
}

/* ---------------- central error handler ---------------- */

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'not_found', message: 'This endpoint does not exist.' });
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.error, message: err.message, details: err.details });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_request', message: 'Invalid JSON in request body.' });
  }
  if (err && err.name === 'MulterError') {
    const map = {
      LIMIT_FILE_SIZE: 'The file is too large.',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field.',
    };
    return res.status(400).json({ error: 'upload_error', message: map[err.code] || 'Upload failed.' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong on our side.' });
}

module.exports = {
  HttpError,
  errors,
  isEmail,
  passwordIssue,
  validateBody,
  notFoundHandler,
  errorHandler,
};
