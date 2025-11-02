const serverless = require('serverless-http');
const app = require('../server');

const handler = serverless(app);

module.exports = (req, res) => handler(req, res);


