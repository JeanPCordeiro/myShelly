# Shelly Scripts

A collection of Shelly IOT Devices scripts :
- **Scheduler.js** : a 24 hour schedule with 30' granularity and web admin panel. Very convenient for pools.
- **Boiler.js** : This Shelly script detects when an oil burner turns on and off using power consumption, measures its runtime, calculates fuel usage in centiliters, and continuously updates the remaining oil level in persistent storage
- **BoilerNTFY.js** : This Shelly script detects when an oil burner turns on and off using power consumption, measures its runtime, calculates fuel usage in centiliters, continuously updates the remaining oil level in persistent storage and send low level alerts via ntfy.sh topic
- **PoolSchedule.mjs** : Estimates swimming pool water temperature hourly using weather data from Open-Meteo (via physical heat balance modeling) and automates filtration relay control with intelligent daily scheduling.

## Simulateur local

Les scripts peuvent être exécutés sans matériel Shelly avec Node.js 18 ou plus récent. Le simulateur fournit les API utilisées dans ce dépôt (`Shelly.call`, KVS, relais, handlers de statut, timers et HTTP server) et avance le temps virtuel à partir d'un scénario JSON.

Le KVS est automatiquement persisté entre deux lancements dans un fichier portant le nom racine du script. Pour `PoolSchedule.mjs`, le fichier créé est `PoolSchedule.kvs.json` :

```sh
node shelly-simulator.mjs PoolSchedule.mjs
```

Chaque appel `KVS.Set` est écrit immédiatement dans ce fichier. Au lancement suivant, `PoolSchedule.mjs` retrouve notamment `pool_temp` et n'effectue pas à nouveau l'initialisation historique si la valeur existe. L'option `--kvs-file` reste disponible pour choisir explicitement un autre emplacement.

Les timers sont réveillés automatiquement pendant l'exécution, sur l'horloge réelle comme sur un appareil Shelly. Le simulateur s'arrête par défaut après 120 secondes ; cette durée peut être modifiée :

```sh
node shelly-simulator.mjs PoolSchedule.mjs --run-seconds 3600
```

Les callbacks de `Timer.set()` sont alors déclenchés à leur échéance réelle. Les délais `afterSeconds` des scénarios sont également mesurés en secondes réelles.

Le simulateur prend également en charge les composants virtuels `number:200`, `text:200`, `text:201` et `boolean:200` utilisés par `PoolSchedule.mjs`. Leurs valeurs sont persistées automatiquement dans `PoolSchedule.virtuals.json`, séparément du KVS, puis restaurées au lancement suivant. `text:201` contient le dernier message du script, tronqué à 250 caractères, et peut être affiché dans Shelly Control. Activez `boolean:200` dans Shelly Control pour demander une réinitialisation complète.

Exemple avec le suivi de chaudière :

```sh
node shelly-simulator.mjs Boiler.js simulator/boiler.json
```

Le scénario démarre avec 25000 cL, simule une puissance de 150 W pendant une heure, puis repasse à 0 W.

Pour tester `PoolSchedule.mjs` avec une météo locale déterministe :

```sh
node shelly-simulator.mjs PoolSchedule.mjs simulator/pool.json
```

Ce scénario fournit une température initiale de 25 °C, évite l'initialisation historique et effectue réellement la requête Open-Meteo. Après une minute, le script doit avoir piloté le relais et enregistré une nouvelle valeur `pool_temp`. Une météo locale peut être injectée dans le JSON avec la propriété `weather` si un test hors ligne est nécessaire.

Pour une piscine nouvellement remplie, configurer dans `PoolSchedule.mjs` :

```js
let FILL_DATE = "2026-09-02";
let INITIAL_WATER_TEMP = 12.0;
```

Le script simule uniquement la période comprise entre `FILL_DATE` et aujourd'hui, puis mémorise `pool_fill_date` dans le KVS. Une modification de `FILL_DATE` relance automatiquement l'initialisation.

Pour une piscine nouvellement remplie, renseigner dans `PoolSchedule.mjs` :

```js
let FILL_DATE = "2026-09-02";
let INITIAL_WATER_TEMP = 12.0;
```

Le script simule uniquement la période comprise entre `FILL_DATE` et aujourd'hui, en partant de `INITIAL_WATER_TEMP`. Il mémorise ensuite `pool_fill_date` dans le KVS. Si la date de remplissage est modifiée, l'initialisation est automatiquement relancée.

Un scénario suit cette forme :

```json
{
	"startTime": "2026-01-01T08:00:00.000Z",
	"kvs": { "OilLevel": 25000 },
	"events": [
		{ "power": 150 },
		{ "afterSeconds": 3600, "power": 0 }
	]
}
```

`afterSeconds` avance l'horloge avant l'événement. Un événement peut aussi appeler un endpoint HTTP enregistré par le script : `{ "request": { "method": "GET", "path": "GetSchedule" } }`.
