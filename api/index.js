// Vercel serverless entry point.
//
// This file does not contain any application logic of its own. It only exposes the
// same Express `app` that Railway and Render run via `node server.js`. Vercel's Node
// runtime treats a module that exports an (req, res) => ... handler (which an Express
// app is) as a serverless function, so no route, business logic, or Drive/Turso setup
// is duplicated here.
module.exports = require('../server.js');
