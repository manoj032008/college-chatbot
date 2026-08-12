const { body, validationResult } = require('express-validator');
const response = require('../utils/response');

const validateSendMessage = [
  body('message').trim().notEmpty().withMessage('Please type a message before sending.'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return response.error(res, errors.array()[0].msg, 400, errors.array());
    }
    next();
  }
];

module.exports = { validateSendMessage };
