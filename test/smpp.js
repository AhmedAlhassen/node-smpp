var assert = require('assert'),
    fs = require('fs'),
    smpp = require('..');

describe('Session', function() {
	var server, port, secure = {};
	var sessionHandler = function(session) {
		session.on('pdu', function(pdu) {
			session.send(pdu.response());
		});
	};

	before(function(done) {
		server = smpp.createServer(sessionHandler);
		server.listen(done);
		port = server.address().port;
	});

	before(function(done) {
		secure = smpp.createServer({
			key: fs.readFileSync(__dirname + '/fixtures/server.key'),
			cert: fs.readFileSync(__dirname + '/fixtures/server.crt')
		}, sessionHandler);
		secure.listen(done);
		//secure.port = secure.address().port;
	});

	after(function(done) {
		server.sessions.forEach(function(session) {
			session.close();
		});
		server.close(done);
	});

	after(function(done) {
		secure.sessions.forEach(function(session) {
			session.close();
		});
		secure.close(done);
	});

	describe('smpp.connect()', async() => {
		it('should successfully establish a connection', async() => {
			const  session = await smpp.connect('smpp://localhost');
			session.close();
		});

		it('should successfully establish a secure connection', async() => {
			const session = await smpp.connect('ssmpp://localhost');
			session.close();
		});
	});

	describe('#send()', () => {
		it('should successfully send a pdu and receive its response', async() => {
			var session = await smpp.connect('smpp://localhost');
			console.log('connected');
			var pdu = new smpp.PDU('enquire_link');
			console.log('sending PDU');
			const result = await session.send(pdu);
		});

		it('should successfully send a pdu using shorthand methods', async() => {
			var session = await smpp.connect('smpp://localhost');
			//var session = await smpp.connect({ port: port, auto_enquire_link_period:10000 });
			const result = await session.enquire_link();
		});
	});
});
