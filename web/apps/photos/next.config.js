const base = require("ente-base/next.config.base.js");

module.exports = {
    ...base,
    ...(process.env.FOTORO_BUILD_DIR
        ? { distDir: process.env.FOTORO_BUILD_DIR }
        : {}),
};
