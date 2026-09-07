# Shelly Scripts

A collection of Shelly IOT Devices scripts :
- **Scheduler.js** : a 24 hour schedule with 30' granularity and web admin panel. Very convenient for pools.
- **Boiler.js** : This Shelly script detects when an oil burner turns on and off using power consumption, measures its runtime, calculates fuel usage in centiliters, and continuously updates the remaining oil level in persistent storage
- **BoilerNTFY.js** : This Shelly script detects when an oil burner turns on and off using power consumption, measures its runtime, calculates fuel usage in centiliters, continuously updates the remaining oil level in persistent storage and send low level alerts via ntfy.sh topic
- **PoolSchedule.mjs** : Estimates swimming pool water temperature hourly using weather data from Open-Meteo (via physical heat balance modeling) and automates filtration relay control with intelligent daily scheduling.

## Simulateur local

Les scripts peuvent être exécutés sans matériel Shelly avec Node.js 18 ou plus récent. Le simulateur fournit les API utilisées dans ce dépôt (`Shelly.call`, KVS, relais, Virtual Components, timers et HTTP server) et exécute le script selon l'horloge réelle.

Le KVS est automatiquement persisté entre deux lancements dans un fichier portant le nom racine du script. Pour `PoolSchedule.mjs`, le fichier créé est `PoolSchedule.kvs.json` :

```sh
node shelly-simulator.mjs PoolSchedule.mjs
```

Chaque appel `KVS.Set` est écrit immédiatement dans ce fichier. Au lancement suivant, `PoolSchedule.mjs` retrouve notamment `pool_temp` et n'effectue pas à nouveau l'initialisation historique si la valeur existe. L'option `--kvs-file` reste disponible pour choisir explicitement un autre emplacement.

Les timers sont réveillés automatiquement pendant l'exécution, sur l'horloge réelle comme sur un appareil Shelly. Le simulateur s'arrête par défaut après 120 secondes ; cette durée peut être modifiée :

```sh
node shelly-simulator.mjs PoolSchedule.mjs --run-seconds 3600
```

Les callbacks de `Timer.set()` sont alors déclenchés à leur échéance réelle.

Le simulateur prend en charge les Virtual Components déclarés dans le fichier `.virtuals.json`. Il n'en crée aucun implicitement : un appel à `Virtual.getHandle(id)` retourne `null` si l'identifiant n'est pas déclaré. Les valeurs sont persistées automatiquement dans `PoolSchedule.virtuals.json`, séparément du KVS, puis restaurées au lancement suivant. Pour `PoolSchedule.mjs`, les composants attendus sont `number:200`, `text:200`, `text:201` et `boolean:200`; `text:201` contient le dernier message et `boolean:200` déclenche une réinitialisation.

Pour une piscine nouvellement remplie, configurer dans `PoolSchedule.mjs` :

```js
let FILL_DATE = "2026-09-02";
let INITIAL_WATER_TEMP = 12.0;
```

Le script simule uniquement la période comprise entre `FILL_DATE` et aujourd'hui, en partant de `INITIAL_WATER_TEMP`. Il mémorise ensuite `pool_fill_date` dans le KVS. Si la date de remplissage est modifiée, l'initialisation est automatiquement relancée.
