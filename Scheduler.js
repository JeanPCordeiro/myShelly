// === CONFIGURATION ===
var RELAY_ID = 0;                  // Relais du moteur de filtration
var KVS_KEY = "pool_planning";     // Clé KVS
var CHECK_INTERVAL_MS = 60000;     // Vérification chaque minute
var WEB_PATH = "planning";         // URL page web
var GET_PATH = "GetSchedule";      // URL lecture planning
var SET_PATH = "SetSchedule";      // URL écriture planning

// === VARIABLES ===
var planning = [];                 // 48 créneaux 0/1
var lastState = -1;

// === INITIALISATION DU PLANNING ===
function initPlanning() {
  Shelly.call("KVS.GET", { key: KVS_KEY }, function (KVS_GET_RESULT) {
    if (KVS_GET_RESULT) {
      planning = JSON.parse(KVS_GET_RESULT.value);
    } else {
      planning = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
      ];
    }
  });
}

initPlanning();

// === SAUVEGARDE ===
function savePlanning() {
  Shelly.call("KVS.Set", { key: KVS_KEY, value: JSON.stringify(planning) });
}

// === CALCUL CRÉNEAU ACTUEL ===
function getCurrentSlot() {
  var now = new Date();
  return Math.floor((now.getHours() * 60 + now.getMinutes()) / 30);
}

// === APPLICATION DU PLANNING ===
function applySchedule() {
  var slot = getCurrentSlot();
  var desired = planning[slot];

  print("slot : ", slot);
  print("desired : ", desired);

  Shelly.call("Switch.Set", { id: RELAY_ID, on: desired == 1 ? true : false });
}

// Vérifie et applique toutes les minutes
Timer.set(CHECK_INTERVAL_MS, true, applySchedule);

// === HANDLERS HTTP ===

// Lecture du planning
function GetScheduleHandler(request, response) {
  var responseObject = { schedule: planning };
  response.body = JSON.stringify(responseObject);
  response.code = 200;
  response.headers = [['Content-Type', 'application/json']];
  response.send();
}

// Écriture du planning
function SetScheduleHandler(request, response) {
  print("on est dans Set");
  print("méthode =", request.method);

  var body = JSON.parse(request.body || "{}");
  planning = body.schedule || planning;

  print(JSON.stringify(planning));
  savePlanning();

  var responseObject = { result: "OK" };
  response.body = JSON.stringify(responseObject);
  response.code = 200;
  response.headers = [['Content-Type', 'application/json']];
  response.send();
}

// === PAGE WEB PRINCIPALE ===
function httpServerHandler(request, response) {
  var info = Shelly.getDeviceInfo();
  var deviceName = info.name;

  var htmlPage =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>⏰ '+deviceName+'</title>' +
  '<style>' +
    'body{font-family:sans-serif;margin:20px;}' +
    'h2{text-align:center;}' +
    '.grid{display:grid;grid-template-columns:repeat(8,1fr);gap:6px;margin-top:20px;}' +
    '.slot{border:1px solid #ccc;padding:6px;text-align:center;cursor:pointer;border-radius:4px;}' +
    '.on{background-color:#4CAF50;color:white;}' +
    '.off{background-color:#eee;color:#333;}' +
    'button{margin-top:20px;padding:10px 20px;font-size:16px;cursor:pointer;}' +
    '.footer{margin-top:30px;text-align:center;color:gray;font-size:13px;}' +
  '</style></head><body>' +
    '<h2>⏰ ' + deviceName + '</h2>' +
    '<p style="text-align:center;">Cliquez sur les cases pour activer/désactiver chaque demi-heure.</p>' +
    '<div class="grid" id="grid"></div>' +
    '<div style="text-align:center;"><button id="saveBtn">💾 Enregistrer</button></div>' +
    '<div style="text-align:center;margin-top:8px;"><button id="reloadBtn">↻ Recharger</button></div>' +
    '<div class="footer">(C) Jean Pierre Cordeiro</div>' +
    '<script>' +
      'function xhrJson(m,u,b,cb){' +
        'var x=new XMLHttpRequest();' +
        'x.open(m,u,true);' +
        'x.setRequestHeader("Content-Type","application/json");' +
        'x.onreadystatechange=function(){' +
          'if(x.readyState===4){cb(x.status,x.responseText);}' +
        '};' +
        'x.send(b?JSON.stringify(b):null);' +
      '}' +

      'var planning=[];' +

      'function draw(){' +
        'var g=document.getElementById("grid");' +
        'g.innerHTML="";' +
        'for(var i=0;i<48;i++){' +
          'var d=document.createElement("div");' +
          'var h=("0"+Math.floor(i/2)).slice(-2);' +
          'var m=i%2?"30":"00";' +
          'd.textContent=h+":"+m;' +
          'd.className="slot "+(planning[i]?"on":"off");' +
          '(function(i,el){' +
            'el.onclick=function(){' +
              'planning[i]=planning[i]?0:1;' +
              'el.className="slot "+(planning[i]?"on":"off");' +
            '};' +
          '})(i,d);' +
          'g.appendChild(d);' +
        '}' +
      '}' +

      'function loadPlanning(){' +
        'xhrJson("GET","/script/1/GetSchedule",{},function(s,t){' +
          'if(s===200){' +
            'var j=JSON.parse(t);' +
            'if(j.schedule){' +
              'planning=j.schedule;' +
              'draw();' +
            '}' +
          '}else{' +
            'alert("Erreur lecture planning");' +
          '}' +
        '});' +
      '}' +

      'function savePlanning(){' +
        'xhrJson("POST","/script/1/SetSchedule",{schedule:planning},function(s){' +
          'alert(s===200?"Planning sauvegardé !":"Erreur sauvegarde");' +
        '});' +
      '}' +

      'document.getElementById("saveBtn").onclick=savePlanning;' +
      'document.getElementById("reloadBtn").onclick=loadPlanning;' +
      'loadPlanning();' +
    '</script></body></html>';

  response.body = htmlPage;
  response.code = 200;
  response.headers = [['Content-Type', 'text/html; version=0.0.4']];
  response.send();
}

// === ENREGISTREMENT DES ENDPOINTS ===
HTTPServer.registerEndpoint(WEB_PATH, httpServerHandler);
HTTPServer.registerEndpoint(GET_PATH, GetScheduleHandler);
HTTPServer.registerEndpoint(SET_PATH, SetScheduleHandler);