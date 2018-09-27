var express = require('express');
var router = express.Router();

let mainCtrl = require('../controllers/main')
    ;

//router.all('*', mainCtrl.common);

/* GET home page. */
router.get('/', mainCtrl.index);

//router.all('*', mainCtrl.commonEnd);

module.exports = router;
