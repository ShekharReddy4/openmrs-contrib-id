'use strict';
var fs = require('fs');

fs.readdirSync(__dirname).forEach(file => {
	var regex = /^(.*).js$/.exec(file);
	if (!regex[1]) {
		return;
	}

	var name = regex[1];
	if (name === 'index') {
		return;
	}

	module.exports[name] = require('./' + name);
});