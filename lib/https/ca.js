var assert = require('assert');
var forge = require('node-forge');
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var pki = forge.pki;
var createSecureContext = require('tls').createSecureContext || crypto.createCredentials;
var util = require('../util');
var config = require('../config');

var CUR_VERSION = process.version;
var SUPPORTS_2048_RSA = parseInt(CUR_VERSION.slice(1), 10) >= 6;
var enableATS = SUPPORTS_2048_RSA && config.ATS;
var HTTPS_DIR = util.mkdir(path.join(config.getDataDir(), 'certs'));
var ROOT_2048_KEY_FILE = path.join(HTTPS_DIR, 'root_2048.key');
var ROOT_2048_CRT_FILE = path.join(HTTPS_DIR, 'root_2048.crt');
var use2048Key = enableATS || (fs.existsSync(ROOT_2048_KEY_FILE) && fs.existsSync(ROOT_2048_CRT_FILE));
var ROOT_KEY_FILE = use2048Key ? ROOT_2048_KEY_FILE : path.join(HTTPS_DIR, 'root.key');
var ROOT_CRT_FILE = use2048Key ? ROOT_2048_CRT_FILE : path.join(HTTPS_DIR, 'root.crt');
var customCertDir = config.certDir;
var customPairs = {};
var wildcardPairs = {};
var cachePairs = {};
var MAC_ADDR = getMacAddress();
var ROOT_KEY, ROOT_CRT;

if (config.ATS) {
  assert(SUPPORTS_2048_RSA, 'Enable ATS requires Node >= 6 (current: '
  + CUR_VERSION + '), access https://nodejs.org to install the latest version.');
}

function getMacAddress() {
  var ifaces = os.networkInterfaces();
  for (var i in ifaces) {
    var addrList = ifaces[i];
    if (addrList) {
      for (var j = 0, len = addrList.length; j< len; j++) {
        var addr = addrList[j];
        if (addr && !addr.internal && addr.family == 'IPv4') {
          return addr.mac || addr.address;
        }
      }
    }
  }
}

function createCertificate(hostname) {
  var cert = customPairs[hostname]
    || wildcardPairs[hostname.slice(hostname.indexOf('.'))]
    || cachePairs[hostname];
  if (cert) {
    return cert;
  }

  cert = createCert(pki.setRsaPublicKey(ROOT_KEY.n, ROOT_KEY.e),
crypto.createHash('sha1')
.update(hostname, 'binary')
.digest('hex'));

  cert.setSubject([{
    name: 'commonName',
    value: hostname
  }]);

  cert.setIssuer(ROOT_CRT.subject.attributes);
  cert.setExtensions([ {
    name: 'subjectAltName',
    altNames: [{
      type: 2,
      value: hostname
    }]
  } ]);
  cert.sign(ROOT_KEY, forge.md.sha256.create());
  cert = cachePairs[hostname] = {
    key: pki.privateKeyToPem(ROOT_KEY),
    cert: pki.certificateToPem(cert)
  };
  return cert;
}

function loadCustomCerts() {
  if (!customCertDir) {
    return;
  }
  var certs = {};
  try {
    fs.readdirSync(customCertDir).forEach(function(name) {
      if (!/^([*_]\.)?(.+)\.(crt|key)$/.test(name)) {
        return;
      }
      var wildcard = RegExp.$1;
      var hostname = (wildcard ? '.' : '') + RegExp.$2;
      var suffix = RegExp.$3;
      var cert = certs[hostname] = certs[hostname] || {};
      if (suffix === 'crt') {
        suffix = 'cert';
      }
      if (wildcard) {
        cert.wildcard = true;
      }
      try {
        cert[suffix] = fs.readFileSync(path.join(customCertDir, name), {encoding: 'utf8'});
      } catch(e) {}
    });
  } catch(e) {}
  var rootCA = certs.root;
  delete certs.root;
  if (rootCA && rootCA.key && rootCA.cert) {
    ROOT_KEY_FILE = path.join(customCertDir, 'root.key');
    ROOT_CRT_FILE = path.join(customCertDir, 'root.crt');
  }
  Object.keys(certs).forEach(function(hostname) {
    var cert = certs[hostname];
    if (!cert || !cert.key || !cert.cert) {
      return;
    }
    if (cert.wildcard) {
      wildcardPairs[hostname] = cert;
    } else {
      customPairs[hostname] = cert;
    }
  });
}

function createRootCA() {
  loadCustomCerts();
  if (ROOT_KEY && ROOT_CRT) {
    return;
  }

  try {
    ROOT_KEY = fs.readFileSync(ROOT_KEY_FILE);
    ROOT_CRT = fs.readFileSync(ROOT_CRT_FILE);
  } catch (e) {
    ROOT_KEY = ROOT_CRT = null;
  }

  if (ROOT_KEY && ROOT_CRT && ROOT_KEY.length && ROOT_CRT.length) {
    ROOT_KEY = pki.privateKeyFromPem(ROOT_KEY);
    ROOT_CRT = pki.certificateFromPem(ROOT_CRT);
  } else {
    var cert = createCACert();
    ROOT_CRT = cert.cert;
    ROOT_KEY = cert.key;
    fs.writeFileSync(ROOT_KEY_FILE, pki.privateKeyToPem(ROOT_KEY).toString());
    fs.writeFileSync(ROOT_CRT_FILE, pki.certificateToPem(ROOT_CRT).toString());
  }

  exports.DEFAULT_CERT_CTX = createSecureContext({
    key: ROOT_KEY,
    cert: ROOT_CRT
  });
}

function createCACert() {
  var keys = pki.rsa.generateKeyPair(SUPPORTS_2048_RSA ? 2048 : 1024);
  var cert = createCert(keys.publicKey);
  var name = [];
  if (config.homeDirname) {
    try {
      //避免特殊字符导致根证书无法安装
      name.push(encodeURIComponent(config.homeDirname.slice(0, 20)));
    } catch(e) {}
  }
  if (MAC_ADDR) {
    name.push(MAC_ADDR);
  }
  name = name.join('@');
  name = 'whistle' + (name ? '(' + name + ')' : '');
  var attrs = [ {
    name : 'commonName',
    value : name
  }, {
    name : 'countryName',
    value : 'CN'
  }, {
    shortName : 'ST',
    value : 'ZJ'
  }, {
    name : 'localityName',
    value : 'HZ'
  }, {
    name : 'organizationName',
    value : name
  }, {
    shortName : 'OU',
    value : 'WPROXY'
  } ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([ {
    name : 'basicConstraints',
    cA : true
  }, {
    name : 'keyUsage',
    keyCertSign : true,
    digitalSignature : true,
    nonRepudiation : true,
    keyEncipherment : true,
    dataEncipherment : true
  }, {
    name : 'extKeyUsage',
    serverAuth : true,
    clientAuth : true,
    codeSigning : true,
    emailProtection : true,
    timeStamping : true
  }, {
    name : 'nsCertType',
    client : true,
    server : true,
    email : true,
    objsign : true,
    sslCA : true,
    emailCA : true,
    objCA : true
  } ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    key: keys.privateKey,
    cert: cert
  };
}

function createCert(publicKey, serialNumber) {
  var cert = pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serialNumber || '01';
  var curYear = new Date().getFullYear();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notBefore.setFullYear(curYear - 10);
  cert.validity.notAfter.setFullYear(curYear + 10);
  return cert;
}

function getRootCAFile() {
  return ROOT_CRT_FILE;
}

createRootCA();// 启动生成ca
exports.getRootCAFile = getRootCAFile;
exports.createCertificate = createCertificate;

