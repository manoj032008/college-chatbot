const logger = require('../utils/logger');
const response = require('../utils/response');

const errorHandler = (err, req, res, next) => {
  logger.error(err.stack || err);
  
  const statusCode = err.statusCode || 500;
  const message = err.message || 'An unexpected error occurred on the server.';
  
  return response.error(res, message, statusCode, process.env.NODE_ENV === 'development' ? err.stack : null);
};

module.exports = errorHandler;
