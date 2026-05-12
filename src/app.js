import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import config from './config/index.js';
import errorHandler from './middleware/errorHandler.js';
import routes from './routes/index.js'; 


const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', environment: config.environment });
});



// 🔹 Mount ALL routes here
app.use('/api', routes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Error handling middleware
app.use(errorHandler);

export default app;