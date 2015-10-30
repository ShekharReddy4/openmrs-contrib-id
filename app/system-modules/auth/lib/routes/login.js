/**
 * This is the login logic for Dashboard
 */
var url = require('url');
var path = require('path');
var async = require('async');
var _ = require('lodash');

var settings = require('../settings');

// Dashboard Common
var Common   = require(global.__commonModule);
var app      = Common.app;
var conf     = Common.conf;
var mid      = Common.mid;
var validate = Common.validate;
var utils    = Common.utils;
var log      = Common.logger.add('express');

var User = require(path.join(global.__apppath, 'model/user'));

app.get(/^\/login\/?$/, mid.forceLogout, validate.receive,
  function(req, res, next) {
    var tmp = path.join(settings.viewPath,'login');
    res.render(tmp);
  }
);

app.post('/login', mid.stripNewlines, function(req, res, next) {
  var username = req.body.loginusername;
  var password = req.body.loginpassword;

  var redirect = req.body.destination || '/';

  var findUser = function (callback) {
    User.findByUsername(username, function (err, user) {
      if (err) {
        return callback(err);
      }
      if (_.isEmpty(user)) {
        return callback({loginFail: 'This user does not exist'});
      }
      return callback(null, user);
    });
  };
  var checkLocked = function (user, callback) {
    if (user.locked) {
      return callback({loginFail: 'You must first verify your e-mail.'});
    }
    return callback(null, user);
  };
  var checkPassword = function (user, callback) {
    if (_.isEmpty(user.password)) {
      return callback({loginFail: 'Your password must be reset first'});
    }
    if (!utils.checkSSHA(password, user.password)) {
      return callback({loginFail: 'Wrong password'});
    }
    return callback(null, user);
  };
  async.waterfall([
    findUser,
    checkLocked,
    checkPassword,
  ],
  function (err, user) {
    if (err) {
      if (_.isEmpty(err.loginFail)) {
        log.debug('login error');
        return next(err);
      }
      log.info('authentication failed for "' + username +
        '" (' + err.loginFail + ')');
      req.flash('error', err.loginFail);
      res.locals({
        fail: {
          loginusername: false,
          loginpassword: true
        },
        values: {
          loginusername: username,
          loginpassword: password
        }
      });
      if (req.body.destination) { // redirect to the destination login page
        var dest = url.resolve(conf.site.url, '/login?destination=' +
          encodeURIComponent(req.body.destination));

        return res.redirect(dest);
      }
      // redirect to generic login page
      return res.redirect(url.resolve(conf.site.url, '/login'));
    }

    // no error
    log.info(username + ': authenticated');
    req.session.user = user;
    log.debug('user ' + username + ' stored in session');

    res.redirect(url.resolve(conf.site.url, decodeURIComponent(redirect)));
  });
});
