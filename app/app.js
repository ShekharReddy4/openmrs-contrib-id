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

var express = require('express'),
	ejs = require('ejs'),
	fs = require('fs'),
	path = require('path'),
	connect = require('connect'),
	mail = require('nodemailer'),
	https = require('https'),
	url = require('url'),
	app = express.createServer(),
	activeResets = new Object;
	
exports.app = app;

// fail if no configuration file found
try {
	fs.readFileSync(__dirname+'/conf.js');
}
catch (e) {
	console.log('ERROR: Configuration file not found at ('+__dirname+'/conf.js)! Exiting…');
	return;
}


var conf = require('./conf'),
	ldap = require('./openmrsid-ldap'),
	mid = require('./express-middleware'),
	log = require('./logger').add('express'),
	validate = require('./validate'),
	environment = require('./environment');

mail.SMTP = conf.email.smtp;

/* Load Modules */
// require('./modules/groups'); // still in development

/* Routes */

app.get('/', function(req, res, next){
	if (req.session.user)
		https.get({host: 'answers.openmrs.org', path: '/users/'+req.session.user.uid }, function(response) {
			if (response.statusCode == 200) app.helpers({osqaUser: true});
			else app.helpers({osqaUser: false});
			
			app.dynamicHelpers({
				
			});
			
			res.render('root');
		});
		
	else
		res.render('signup', {
			bodyAppend: '<script type="text/javascript" src="https://www.google.com/recaptcha/api/challenge?	k='+conf.validation.recaptchaPublic+'"></script>',
			title: 'OpenMRS ID - Manage Your Community Account'
		});
});

app.get(/^\/login\/?$/, mid.forceLogout, function(req, res, next){
	res.render('login');
});

app.post('/login', mid.stripNewlines, validate(), function(req, res, next){
	var completed = 0, needToComplete = 1, userobj = {},
		username = req.body.loginusername, password = req.body.loginpassword;
		
	var redirect = (req.body.destination) ? req.body.destination : '/';
		
	// do the actual authentication by forming a unique bind to the server as the authenticated user;
	// closes immediately (all operations work through system's LDAP bind)
	ldap.authenticate(username, password, function(e){
		ldap.close(username);
		
		if (e) { // authentication error
			if (e.message == '49' || e.message == '34' || e.message == '53') { // login failed
				log.debug('known login failure');
				log.info('authentication failed for "'+username+'" ('+e.message+')');
				req.flash('error', 'Login failed.');
				app.helpers({fail: {loginusername: false, loginpassword: true},
					values: {loginusername: username,
					loginpassword: password}});
				return res.redirect(url.resolve(conf.site.url, '/login'));
			}
			else {log.debug('login error');return next(e);}
		}		
		
		log.info(username+': authenticated'); // no error!
					
		// get a crowd SSO token and set the cookie for it
		// not implemented yet :-(
		/*crowd.getToken(username, password, function(error, token) {
			if (error && error.name != 403) next(e);
			else res.cookie('crowd.token_key', token);
			finish();
		})*/
					
		// get user's profile and put it in memory
		log.trace('getting user data');
		ldap.getUser(username, function(e, userobj) {
			log.trace(' returned');
			if (e) return next(e);
			req.session.user = userobj;
			log.debug('user '+username+' stored in session');
			app.helpers()._locals.clearErrors(); // keeps "undefined" from showing up in error values
			finish();
		});
		
		var finish = function() {
			completed++;
			if (completed == needToComplete) {
				res.redirect(url.resolve(conf.site.url, decodeURIComponent(redirect)));
			}
		}
	});
});

app.get('/signup', mid.forceLogout, function(req, res, next){
	res.render('signup', {
		title: 'OpenMRS ID - Sign Up',
		bodyAppend: '<script type="text/javascript" src="https://www.google.com/recaptcha/api/challenge?	k='+conf.validation.recaptchaPublic+'"></script>'
	});
});

app.post('/signup', mid.forceLogout, mid.forceCaptcha, validate(), function(req, res, next){
	var id = req.body.username, first = req.body.firstname, last = req.body.lastname,
		email = req.body.email, pass = req.body.password, captcha = req.body.recaptcha_response_field;
		
	if (!id || !first || !last || !email || !pass || !captcha) {
		res.send('Unauthorized POST error', { 'Content-Type': 'text/plain' }, 403);
		res.end();
	}
		
	var id = id.toLowerCase();
	
	ldap.addUser(id, first, last, email, pass, function(e, userobj){
		if (e) return next(e);
		log.info('created account "'+id+'"');
		
		fs.readFile(path.join(__dirname, '../views/email/welcome.ejs'), function(err, data) {
		if (err) return next(err);
		var template = data.toString();
		var rendered = ejs.render(template, {locals: 
			{displayName: first+' '+last, username: id, siteURL: conf.site.url, url: url}}
		);
			mail.send_mail(
			    {   sender: "'OpenMRS ID Dashboard' <id-noreply@openmrs.org>",
			        to: email,
			        subject:'[OpenMRS] Welcome to the OpenMRS Community',
			        html: rendered
			    }, function(e, success){
			    	if (e) return log.error(e.stack);
			        log.info('sent welcome mail to '+email);
			    }
			);
		});
		
		req.flash('success', 'Your account was successfully created. Welcome!');
		req.session.user = userobj;
		res.redirect('/');
	});
});

app.get('/checkuser/*', function(req, res, next){
	ldap.getUser(req.params[0], function(e, data){
		if (e) {
			if (e.message=='User data not found') res.end(JSON.stringify({exists: false}));
			else if (e.message=='Illegal username specified') res.end(JSON.stringify({illegal: true}));
		}
		else if (data) res.end(JSON.stringify({exists: true}));
		else next(e);
	});
});

app.get('/disconnect', function(req, res, next) {
	if (req.session.user) {
		log.info(req.session.user.uid+': disconnecting');
		req.session.destroy();
	}
	res.redirect('/');
});

app.get('/profile', mid.forceLogin, function(req, res, next){
	var sidebar = app.helpers()._locals.sidebar;
	var sidebar = (typeof sidebar == 'object') ? sidebar : []; // if no sidebars yet, set as empty array
	
	res.render('edit-profile', {sidebar: sidebar.concat(['sidebar/editprofile-avatar'])});
});

app.get('/password', mid.forceLogin, function(req, res, next){
	res.render('edit-password');
});

app.post('/profile', mid.forceLogin, validate(), function(req, res, next){
	var updUser = req.session.user, body = req.body;
	if ((updUser.cn != body.firstname) || (updUser.sn != body.lastname)) updUser.displayName = body.firstname+' '+body.lastname;
	
	updUser.cn = body.firstname, updUser.sn = body.lastname, updUser.mail = body.email;
	
	if (body.secondaryemail) updUser.otherMailbox = (typeof body.secondaryemail=='object') ? body.secondaryemail : [body.secondaryemail];
	else updUser.otherMailbox = [];
	
	if (updUser.objectClass.indexOf('extensibleObject') < 0) { // for secondaryMail support; someday this should be admin-configurable
		if (typeof updUser.objectClass == 'string') updUser.objectClass = [updUser.objectClass];
		updUser.objectClass.push('extensibleObject');
	}
	
	ldap.updateUser(updUser, function(e, returnedUser){
		log.trace('user update returned');
		if (e) return next(e);
		log.trace('user update no errors');
		log.info(returnedUser.uid+': profile updated');
		req.session.user = returnedUser;
		
		req.flash('success', 'Profile updated.')
			res.redirect('/');
	});
});

app.post('/password', mid.forceLogin, validate(), function(req, res, next){
	var updUser = req.session.user;
	ldap.changePassword(updUser, req.body.currentpassword, req.body.newpassword, function(e){
		log.trace('password change return');
		if (e) console.log(e.msgid);
		if (e) return next(e);
		log.trace('password change no errors');
		log.info(updUser.uid+': password updated');
		
		req.flash('success', 'Password changed.')
		res.redirect('/');
	});
});

app.get('/reset', mid.forceLogout, function(req, res, next) {
	res.render('reset-public');
});

app.post('/reset', mid.forceLogout, function(req, res, next) {
	var resetCredential = req.body.resetCredential, username = '', email = '';
	
	if (resetCredential.indexOf('@') < 0) {
		ldap.getUser(resetCredential, function(e, obj){gotUser(e, obj);});
	}
	else if (resetCredential.indexOf('@') > -1) {
		ldap.getUserByEmail(resetCredential, function(e, obj){gotUser(e, obj);});
	}
	
	function gotUser(e, obj) {
		function finish() {
			req.flash('info', 'If the specified account exists, an email has been sent to your address(es) with further instructions to reset your password.');
	        return res.redirect('/');
		}
		
		if (e) {
			if (e.message=='User data not found') {
				log.info('reset requested for nonexistent user "'+resetCredential+'"');
				return finish();
			}
			else {
				return next(e);
			}
		}
		
		username = obj[conf.ldap.user.username];
		email = obj[conf.ldap.user.email];
		secondaryMail = (obj[conf.ldap.user.secondaryemail]) ? obj[conf.ldap.user.secondaryemail] : [];
		
		var resetId = connect.utils.uid(16),
			expireDate = new Date(Date.now() + 15000/* 7200000 */)
		activeResets[resetId] = new Object;
		activeResets[resetId].user = obj;
		activeResets[resetId].username = username;
		activeResets[resetId].email = email;
		activeResets[resetId].timeout = setTimeout(function(){
			log.info('password reset for '+req.body.resetCredential+' expired');
			delete activeResets[resetId];
		}, conf.ldap.user.passwordResetTimeout);
		log.debug('activeResets set');
		
		fs.readFile(path.join(__dirname, '../views/email/password-reset.ejs'), 'utf-8', function(err, data) {
			if (err) return next(err);
			var template = data.toString();
			var rendered = ejs.render(template, {locals: {
				username: username,
				email: email,
				secondaryMail: secondaryMail,
				resetId: resetId,
				displayName: obj[conf.ldap.user.displayname],
				siteURL: conf.site.url,
				expireDate: expireDate.toLocaleString(),
				url: url
			}});
					
			mail.send_mail(
			    {   sender: "'OpenMRS ID Dashboard' <id-noreply@openmrs.org>",
			        to: secondaryMail.concat(email).toString(),
			        subject:'[OpenMRS] Password Reset for '+username,
			        html: rendered
			    }, function(e, success){
			    	if (e) return next(e);
			    	else {
				        log.info('sent reset mail to '+secondaryMail.concat(email).toString());
				        finish();
					}
			    }
			);
			
		});
	}

	});

app.get('/reset/:id', function(req, res, next){
	var resetId = req.params.id;
	if (activeResets[req.params.id])
		res.render('reset-private', {username: activeResets[req.params.id].username});
	else {
		req.flash('error', 'The requested password reset has expired or does not exist.');
		res.redirect('/');
	}
});

app.post('/reset/:id', validate(), function(req, res, next){
	ldap.resetPassword(activeResets[req.params.id].username, req.body.newpassword, function(e){
		if (e) return next(e);
		clearTimeout(activeResets[req.params.id].timeout);
		log.info('password reset for "'+activeResets[req.params.id].username+'"');
		delete activeResets[req.params.id];
		req.flash('success', 'Password has been reset successfully. You may now log in across the OpenMRS Community.');
		app.helpers()._locals.clearErrors(); // keeps "undefined" from showing up in error values
		res.redirect('/');
	});
	
});

app.get('/resource/*', function(req, res, next){
	var resourcePath = path.join(__dirname, '/../resource/', req.params[0]);
	res.sendfile(resourcePath);
});

// Legacy Redirects
app.get('/edit/profile?', function(req, res){res.redirect('/profile')});
app.get('/edit/password', function(req, res){res.redirect('/password')});


/* App startup: */
app.listen(3000);
log.info('Express started on port '+app.address().port);
