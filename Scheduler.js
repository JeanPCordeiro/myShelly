// === CONFIGURATION ===
var RELAY_ID = 0;                  // Relais du moteur de filtration
var KVS_KEY = "pool_planning";     // Clé KVS
var KVS_MODE_KEY = "pool_mode";    // Clé KVS pour le mode
var CHECK_INTERVAL_MS = 60000;     // Vérification chaque minute
var WEB_PATH = "planning";         // URL page web
var GET_PATH = "GetSchedule";      // URL lecture planning
var SET_PATH = "SetSchedule";      // URL écriture planning
var MODE_PATH = "SetMode";         // Changement de mode
var JS_PATH = "pool.js";       // Script JS

// === VARIABLES ===
var planning = [];                 // 48 créneaux 0/1
var manualMode = "auto"; 

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
  
  Shelly.call("KVS.GET", { key: KVS_MODE_KEY }, function(res) {
    if (res && res.value) {
      manualMode = res.value;
    } else {
      manualMode = "auto";
    }
  });
}

// === SAUVEGARDE DU PLANNING ===
function savePlanning() {
  Shelly.call("KVS.Set", { key: KVS_KEY, value: JSON.stringify(planning) });
}

function saveMode() {
  Shelly.call("KVS.Set", { key: KVS_MODE_KEY, value: manualMode });
}

// === CALCUL CRÉNEAU ACTUEL ===
function getCurrentSlot() {
  var now = new Date();
  return Math.floor((now.getHours() * 60 + now.getMinutes()) / 30);
}

// === APPLICATION DU PLANNING ===
function applySchedule() {
  print("Manual mode : ",manualMode);
  if (manualMode === "on") {
    Shelly.call("Switch.Set", { id: RELAY_ID, on: true });
    print("Mode manuel : Forcé ON");
    return;
  }

  if (manualMode === "off") {
    Shelly.call("Switch.Set", { id: RELAY_ID, on: false });
    print("Mode manuel : Forcé OFF");
    return;
  }

  // Mode automatique
  var slot = getCurrentSlot();
  var desired = planning[slot];
  print("Slot : ",slot);
  print("Desired : ",desired);;
  Shelly.call("Switch.Set", { id: RELAY_ID, on: desired == 1 ? true : false });
}

// === HANDLERS HTTP ===

// Lecture du planning
function GetScheduleHandler(request, response) {
  var responseObject = { schedule: planning, mode: manualMode };
  response.body = JSON.stringify(responseObject);
  response.code = 200;
  response.headers = [['Content-Type', 'application/json']];
  response.send();
}

// Écriture du planning
function SetScheduleHandler(request, response) {
  var body = JSON.parse(request.body || "{}");
  planning = body.schedule || planning;
  savePlanning();
  applySchedule();
  var responseObject = { result: "OK" };
  response.body = JSON.stringify(responseObject);
  response.code = 200;
  response.headers = [['Content-Type', 'application/json']];
  response.send();
}

function SetModeHandler(request, response) {
  var body = JSON.parse(request.body || "{}");
  if (body.mode === "auto" || body.mode === "on" || body.mode === "off") {
    manualMode = body.mode;
    saveMode();
    applySchedule();
  }
  var responseObject = { result: manualMode };
  response.body = JSON.stringify(responseObject);
  response.code = 200;
  response.headers = [["Content-Type", "application/json"]];
  response.send();
}


// === PAGE HTML ===
function httpServerHandler(request, response) {
  var info = Shelly.getDeviceInfo();
  var deviceName = info.name || "Shelly";

  var htmlPage =
'<!DOCTYPE html><html><head><meta charset="utf-8"><title>Filtration Piscine</title>'+
'<style>body{font-family:sans-serif;margin:20px}h2{text-align:center}.mode{text-align:center;margin:10px 0;background:#f5f5f5;padding:8px;border-radius:6px}.grid{display:grid;grid-template-columns:repeat(8,1fr);gap:6px;margin-top:20px}.slot{border:1px solid #ccc;padding:6px;text-align:center;cursor:pointer;border-radius:4px}.on{background:#4CAF50;color:#fff}.off{background:#eee;color:#333}button{margin-top:15px;padding:8px 16px;font-size:14px;cursor:pointer}.footer{text-align:center;margin-top:20px;color:gray;font-size:13px}</style></head>'+
'<body><h2>⏰ Programmation – '+deviceName+'</h2>'+
'<div class="mode"><label><input type="radio" name="mode" value="auto">Auto</label><label><input type="radio" name="mode" value="on">ON</label><label><input type="radio" name="mode" value="off">OFF</label><span id="st" style="display:inline-block;width:14px;height:14px;border-radius:50%;margin-left:20px;background:#999"></span></div>'+
'<p style="text-align:center">Cliquez sur les cases pour activer/désactiver chaque demi-heure.</p>'+
'<div class="grid" id="grid"></div>'+
'<div style="text-align:center"><button id="saveBtn">💾 Enregistrer</button> <button id="reloadBtn">↻ Recharger</button></div>'+
'<div class="footer">Shelly Pro 1 PM – Script</div>'+
'<script src="/script/1/'+JS_PATH+'"></script></body></html>';

  response.body = htmlPage;
  response.code = 200;
  response.headers = [["Content-Type", "text/html"]];
  response.send();
}

// === SCRIPT JS SERVI SÉPARÉMENT ===
function jsHandler(request, response) {
  var jsCode =
'function j(m,u,b,c){var x=new XMLHttpRequest();x.open(m,u,true);x.setRequestHeader("Content-Type","application/json");x.onreadystatechange=function(){if(x.readyState===4)c(x.status,x.responseText)};x.send(b?JSON.stringify(b):null);}'+
'var p=[],mode="auto";'+
'function d(){var g=document.getElementById("grid");g.innerHTML="";for(var i=0;i<48;i++){var e=document.createElement("div"),h=("0"+Math.floor(i/2)).slice(-2),m=i%2?"30":"00";e.textContent=h+":"+m;e.className="slot "+(p[i]?"on":"off");(function(i,el){el.onclick=function(){p[i]=p[i]?0:1;el.className="slot "+(p[i]?"on":"off");};})(i,e);g.appendChild(e);}}'+
'function load(){j("GET","/script/1/GetSchedule",null,function(s,t){if(s===200){var r=JSON.parse(t);if(r.schedule)p=r.schedule;if(r.mode)mode=r.mode;d();u();st();}});}'+
'function save(){j("POST","/script/1/SetSchedule",{schedule:p},function(s){alert(s===200?"Planning sauvegardé !":"Erreur sauvegarde");});}'+
'function change(mo){mode=mo;j("POST","/script/1/SetMode",{mode:mode},function(){u();});}'+
'function u(){var r=document.getElementsByName("mode");for(var i=0;i<r.length;i++)r[i].checked=(r[i].value===mode);}'+
'function st(){var x=new XMLHttpRequest();x.open("GET","/rpc/Switch.GetStatus?id=0",true);x.onreadystatechange=function(){if(x.readyState===4&&x.status===200){try{var r=JSON.parse(x.responseText);document.getElementById("st").style.background=r.output?"#0a0":"#a00";}catch(e){}}};x.send(null);}'+
'document.getElementById("saveBtn").onclick=save;document.getElementById("reloadBtn").onclick=load;var r=document.getElementsByName("mode");for(var i=0;i<r.length;i++)r[i].onclick=function(){change(this.value);};load();setInterval(st,10000);';

  response.body = jsCode;
  response.code = 200;
  response.headers = [["Content-Type", "application/javascript"]];
  response.send();
}

// === ENREGISTREMENT DES ENDPOINTS ===
HTTPServer.registerEndpoint(WEB_PATH, httpServerHandler);
HTTPServer.registerEndpoint(GET_PATH, GetScheduleHandler);
HTTPServer.registerEndpoint(SET_PATH, SetScheduleHandler);
HTTPServer.registerEndpoint(MODE_PATH, SetModeHandler);
HTTPServer.registerEndpoint(JS_PATH, jsHandler);

// Chargement du Planning
initPlanning();

// Vérifie et applique toutes les minutes
Timer.set(CHECK_INTERVAL_MS, true, applySchedule);
