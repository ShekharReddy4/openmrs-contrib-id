/**
 * The contents of this file are subject to the OpenMRS Public License
 * Version 1.1 (the "License"); you may not use this file except in
 * compliance with the License. You may obtain a copy of the License at
 * http://license.openmrs.org
 *
 * Software distributed under the License is distributed on an "AS IS"
 * basis, WITHOUT WARRANTY OF ANY KIND, either express or implied. See the
 * License for the specific language governing rights and limitations
 * under the License.
 *
 * Copyright (C) OpenMRS, LLC.  All Rights Reserved.
 */

var Recaptcha = require('recaptcha').Recaptcha,
    url = require('url'),
    conf = require('../../conf'),
    ldap = require('../../ldap'),
    db = require('../../db'),
    log = require('../../logger').add('validation/process');

module.exports = function(redirect) {
    return function(req, res, next) {
        if (req.body) {
            var b = req.body, user = req.session.user, calls = 1, called = 0, reachedEnd, failures = {}, failed = false, values = {};
            var fail = function(field, reason, idx) {
                failed = true;

                failures[field] = {
                    value: b[field],
                    index: idx || null,
                    reason: reason || null
                };

                log.debug('validation error in '+field);
            };
            var empty = function(field) {
                if (!b[field]) {
                    fail(field);
                    return false;
                }
                else return true;
            };
            var unique = function(field) {
                for (var otherField in b) {
                    if (b[field] == b[otherField]) return false;
                }
                return true;
            };
            var finish = function() {
                called++;
                if (called == calls && reachedEnd) {
                    log.debug('Finished validation, sending results');
                    var data = ({
                        vals: values,
                        fail: failures
                    });
                    if (failed === true) {
                        req.session.validationState = data;
                        if (redirect) return res.redirect(redirect); // redirect to predefined destination
                        else if (req.body.destination) { // redirect to the destination login page
                            return res.redirect(url.resolve(req.url, '?destination='+encodeURIComponent(req.body.destination)));
                        }
                        else return res.redirect(req.url); // redirect back to original page
                    }
                    else return next();
                }
            };

            for (var field in req.body) {
                values[field] = {
                    value: req.body[field]
                };

                // only validate if field has been changed OR if field is not part of user (such as recaptcha validation)
                if (!user || !user[field] || (user[field] && b[field] != user[field])) {

                    if (field == 'username') {
                        if (empty(field) && !conf.user.usernameRegex.exec(b[field])) fail(field); // not a legal username
                        else { // check against current usernames
                            calls++;
                            ldap.getUser.call(this, b[field], function(e, obj){
                                if (obj) fail('username', 'This username is already taken. Better luck next time.');
                                finish();
                            });
                        }
                    }
                    /*if (field == 'email') {
                        if (empty(field) && !conf.email.validation.emailRegex.test(b[field])) fail(field); // not an email string
                        else if (b[field].indexOf('+') > -1 && !conf.validation.allowPlusInEmail) fail(field, 'Due to incompatibilities with the Google Apps APIs, email addresses cannot contain "+".'); // ensure address doesn't break Google
                        else if (conf.email.validation.forceUniquePrimaryEmail) { // force unique email address
                            calls++;
                            var thisField = field;
                            ldap.getUserByEmail(b[field], function(e, obj){
                                if (obj) if(!user || (user && user.dn != obj.dn)) fail(thisField, 'This email address is already registered. A unique email address must be provided.');
                                finish();
                            });
                        }
                    }*/
                    if (field == 'emails') {
                        // treat a single secondary-email list as multiple to keep validation DRY
                        if (typeof b[field] == 'string') {
                            b[field] = [b[field]];
                            values[field] = [b[field]];
                        }

                        // perform validation
                        for (var i=0; i<b[field].length; i++) {
                            if (!b[field][i]) b[field].splice(i, 1); // delete any empty cells
                            else {
                                if ((!conf.email.validation.emailRegex.test(b[field][i]))) fail(field, undefined, i); // ensure the text entered is an email address

                                if (b[field][i].indexOf('+') > -1 && !conf.validation.allowPlusInEmail) fail(field, 'Due to incompatibilities with the Google Apps APIs, email addresses cannot contain "+".', i); // ensure address doesn't break Google

                                if (conf.email.validation.forceUniqueSecondaryEmail) { // ensure address is unique
                                    calls++;
                                    var thisField = field;
                                    db.find('Emails', {address: b[field][i]}, function(err, inst) {
                                        if (inst.username !== user.username)
                                            fail(thisField, 'This email address is already registered. A unique email address must be provided.', b[thisField].indexOf(call));
                                        finish();
                                    });
                                }
                            }
                        }
                    }
                    if (field == 'password' || field == 'newpassword')
                        if (b[field].length < 8) fail(field);
                    if (field == 'confirmpassword')
                        if (b['newpassword'] != b[field]) fail(field);
                    if (field == 'currentpassword') {
                        if (!b[field]) fail(currentField, 'Authentication required to change password.');
                        else {
                            var currentField = field;
                            calls++;
                            ldap.authenticate(user.username, b[field], function(e){
                                ldap.close(user.username);
                                if (e && (e.message == 'Invalid credentials' || e.message == 'Bind requires options: binddn and password')) // login failed
                                    fail(currentField, 'Authentication failed.');
                                finish();
                            });
                        }
                    }
                    if (field == 'recaptcha_response_field') {
                        calls++; // need to wait for the verification callback
                        var captchaData = {
                            remoteip:  req.connection.remoteAddress,
                            challenge: req.body.recaptcha_challenge_field,
                            response:  req.body.recaptcha_response_field
                        }, recaptcha = new Recaptcha(conf.validation.recaptchaPublic, conf.validation.recaptchaPrivate, captchaData);

                        recaptcha.verify(function(success, error_code) {
                            if (!success) fail(field);
                            finish();
                        });
                    }
                    if (field == 'firstname' || field == 'lastname' || field == 'loginusername' || field == 'loginpassword')
                        empty(field);
                }
            }
            reachedEnd = true;
            finish();
        }
        else next();
    };
};