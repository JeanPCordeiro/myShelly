/*************************************************************
 *  OIL BURNER CONSUMPTION TRACKER (Shelly Script)
 *  Optimized logging version
 *
 *  Units:
 *  - Power: W
 *  - Time: s
 *  - Consumption: cL
 *  - OilLevel: cL
 *************************************************************/

/******************** CONFIG *************************/

const ON_THRESHOLD  = 120;
const OFF_THRESHOLD = 80;

const CL_PER_HOUR = 2.27125 * 100;

const MIN_BURN_SECONDS = 10;

const KEY_LAST_STATE = "LastState";
const KEY_ON_TIME    = "OnTime";
const KEY_OIL_LEVEL  = "OilLevel";

let processing = false;


/******************** UTIL ****************************/

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function getNumberFromKVS(key, def, cb) {

  Shelly.call("KVS.get", { key: key }, function (r) {

    if (!r || r.value === null) {
      cb(def);
      return;
    }

    cb(Number(r.value));
  });
}

function setKVS(key, val) {
  Shelly.call("KVS.set", { key: key, value: val });
}


/******************** MAIN ****************************/

Shelly.addStatusHandler(function (status) {

  if (status.name !== "switch" || status.id !== 0) return;
  if (typeof status.delta.apower === "undefined") return;
  if (processing) return;

  processing = true;

  let watts = status.delta.apower;

  /******** Determine state ********/

  let req = null;

  if (watts > ON_THRESHOLD)      req = 1;
  else if (watts < OFF_THRESHOLD) req = 0;
  else {
    processing = false;
    return;
  }

  /******** Read last state ********/

  getNumberFromKVS(KEY_LAST_STATE, 0, function (last) {

    if (last === req) {
      processing = false;
      return;
    }

    /************** ON **************/

    if (req === 1) {

      let start = nowSeconds();

      setKVS(KEY_ON_TIME, start);
      setKVS(KEY_LAST_STATE, 1);

      // Single compact log
      print("ON  @ " + start + " | " + watts + "W");

      processing = false;
      return;
    }

    /************** OFF *************/

    if (req === 0) {

      getNumberFromKVS(KEY_ON_TIME, null, function (onTime) {

        if (onTime === null) {
          setKVS(KEY_LAST_STATE, 0);
          processing = false;
          return;
        }

        let stop = nowSeconds();
        let burn = stop - onTime;

        if (burn < MIN_BURN_SECONDS) {
          setKVS(KEY_LAST_STATE, 0);
          processing = false;
          return;
        }

        let cons = Math.round(
          burn * CL_PER_HOUR / 3600
        );

        getNumberFromKVS(KEY_OIL_LEVEL, 0, function (oil) {

          let newOil = oil - cons;
          if (newOil < 0) newOil = 0;

          setKVS(KEY_OIL_LEVEL, newOil);
          setKVS(KEY_LAST_STATE, 0);

          // Single compact log
          print(
            "OFF | " +
            burn + "s | " +
            cons + "cL | " +
            oil + "→" + newOil
          );

          processing = false;
        });
      });
    }
  });
});
