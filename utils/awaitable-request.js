let request = require('request');

module.exports = function(options) {
    return new Promise(function (resolve, reject) {
        request(options, function(err, res, body) {
            if (err) {
                resolve(err);
                return;
            }
            resolve(body);
        });
    });
}