require('dotenv').config();
const express = require('express');
const cors = require('cors');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const app = express();

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
  ],
});

// Allow all origins in dev, or restrict via CORS_ORIGIN env var
const allowedOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({
  origin: allowedOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Express trust proxy is required when your app is behind a reverse proxy
// (e.g., Nginx/ALB). express-rate-limit validates that X-Forwarded-For is
// only used when trust proxy is enabled.
// Use a safe default: only trust the first proxy hop.
app.set('trust proxy', process.env.TRUST_PROXY || 1);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});
app.use(limiter);


app.use(express.json({ limit: '10mb' }));

app.use('/api/projects',  require('./routes/projects'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/terraform', require('./routes/terraform'));
app.use('/api/aws', require('./routes/aws'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
// Force IPv4 (avoids IPv6 ::1 vs 127.0.0.1 mismatches)
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  logger.info(`✅ Backend running on http://${HOST}:${PORT}`);
  logger.info(`   CORS origin: ${allowedOrigin}`);
  logger.info(`   DB: ${process.env.DATABASE_URL ? '✓ configured' : '✗ DATABASE_URL missing!'}`);
});
