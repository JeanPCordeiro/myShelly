/**
 * ==============================================================================
 * Script Name: Pool Thermal Balance & Filtration Manager
 * Target Hardware: Shelly Pro 1 (mJS Engine)
 * Description: Estimates swimming pool water temperature hourly using weather data 
 *              from Open-Meteo (via physical heat balance modeling) and automates 
 *              filtration relay control with intelligent daily scheduling.
 * Author: JP.Cordeiro
 * Version: 2.2
 * ==============================================================================
 */

// --- PARAMETRES DE LA PISCINE ---
// A adapter pour chaque installation et chaque remplissage.
let LENGTH = 5.0;
let WIDTH = 3.0;
let DEPTH = 1.5;
let COVER_TYPE = "none"; // "none", "cover", "enclosure"
let LATITUDE = "46.134"; // Aytré
let LONGITUDE = "-1.115";
let FILL_DATE = "2026-09-02"; // Date de remplissage, format YYYY-MM-DD
let INITIAL_WATER_TEMP = 15.0; // Temperature de l'eau le jour du remplissage
let PUMP_FLOW_M3H = 10.0; // Debit reel estime de la pompe, en m3/h

// --- PARAMETRES DE L'ALGORITHME ---
// A adapter selon la pompe, les contraintes de voisinage et le climat.
let TARGET_TURNOVERS = 3.0; // Nombre de renouvellements du volume par jour en usage normal
let MIN_FILTRATION_HOURS = 4;
let MAX_FILTRATION_HOURS = 24; // Plafond technique; la plage silencieuse fixe la limite effective
let FREEZE_PROTECTION_WATER_TEMP = 3; // Secours si l'eau descend a ce seuil
let HEATWAVE_WATER_TEMP = 28; // Debut de la majoration canicule
let EXTREME_HEAT_WATER_TEMP = 30; // Renforcement de la filtration par forte chaleur
let FREEZE_PROTECTION_AIR_TEMP = 2; // Protection si la temperature exterieure est proche du gel
let HEATWAVE_AIR_TEMP = 32; // Renforcement si l'air est tres chaud
let EXTREME_HEAT_AIR_TEMP = 35;
let HIGH_WIND_SPEED = 30; // Vent fort en km/h : risque accru de debris et d'evaporation
let QUIET_START_HOUR = 22; // Debut de la periode silencieuse
let QUIET_END_HOUR = 7; // Fin de la periode silencieuse

// --- PARAMETRES TECHNIQUES ---
// Ne pas modifier sauf adaptation du fonctionnement du script.
let KEY_POOL_TEMP = "pool_temp";
let KEY_LAST_UPDATE_HOUR = "last_update_hour";
let KEY_FILL_DATE = "pool_fill_date";
let RESET_COMPONENT = "boolean:200";
let LAST_LOG_COMPONENT = "text:201";

// Valeurs calculees a partir des dimensions de la piscine.
let SURFACE = LENGTH * WIDTH;
let VOLUME = SURFACE * DEPTH;
let WATER_MASS = VOLUME * 1000;

// Constantes physiques et URL des services externes.
let C_P = 4184;
let ARCHIVE_RETRY_DELAY_MS = 5000;
let REALTIME_TIMEOUT_SECONDS = 15;
let REALTIME_URL = "https://api.open-meteo.com/v1/forecast?latitude=" + LATITUDE + "&longitude=" + LONGITUDE + "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,shortwave_radiation,cloud_cover";
let ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive?latitude=" + LATITUDE + "&longitude=" + LONGITUDE + "&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,shortwave_radiation,cloud_cover";
let mainTimer = null;
let resetComponent = Virtual.getHandle(RESET_COMPONENT);
let lastLogComponent = Virtual.getHandle(LAST_LOG_COMPONENT);
let resetInProgress = false;
let realtimeRequestInProgress = false;
let latestWeatherData = null;

function padTimePart(value) {
    return value < 10 ? "0" + value : "" + value;
}

function getLogTimestamp() {
    let now = new Date();
    return now.getFullYear() + "-" + padTimePart(now.getMonth() + 1) + "-" + padTimePart(now.getDate()) +
        " " + padTimePart(now.getHours()) + ":" + padTimePart(now.getMinutes()) + ":" + padTimePart(now.getSeconds());
}

function log(message) {
    print(message);
    if (lastLogComponent) lastLogComponent.setValue("[" + getLogTimestamp() + "] " + String(message).slice(0, 230));
}

/**
 * Polynomial approximation of water saturation vapor pressure (in kPa).
 */
function approxVaporPressure(T) {
    return (0.0046 * T * T) - (0.0327 * T) + 1.094;
}

/**
 * Computes the global heat balance (flux in W/m²) and derives the water 
 * temperature variation (Delta T) for a one-hour period.
 */
function calculateHeatBalance(weatherData, currentWaterTemp) {
    let t_air = weatherData.temperature_2m;
    let rh = weatherData.relative_humidity_2m;
    let wind_speed = weatherData.wind_speed_10m / 3.6; 
    let solar_rad = weatherData.shortwave_radiation;
    let clouds = weatherData.cloud_cover / 100.0;

    let surface_wind = wind_speed * 0.5;
    let solar_trans = 0.8;
    let evap_coeff = 1.0;
    let conv_coeff = 1.0;
    let night_rad = 1.0;

    // Adjustment of physical coefficients based on pool cover type
    if (COVER_TYPE === "cover") {
        surface_wind = 0; solar_trans = 0.45; evap_coeff = 0.05; conv_coeff = 0.8; night_rad = 0.9;      
    } else if (COVER_TYPE === "enclosure") {
        surface_wind = 0.1; solar_trans = 0.35; evap_coeff = 0.40; conv_coeff = 0.6; night_rad = 0.1;      
    }

    let solar_flux = solar_rad * solar_trans;
    
    let h_c = 3.1 + (4.1 * surface_wind);
    let conv_flux = h_c * (t_air - currentWaterTemp) * conv_coeff;

    let p_water = approxVaporPressure(currentWaterTemp);
    let p_air = (rh / 100.0) * approxVaporPressure(t_air);
    let evap_flux = evap_coeff * (25 + (19 * surface_wind)) * (p_water - p_air);
    if (evap_flux < 0) evap_flux = 0;

    let sky_temp = t_air - (20 * (1 - clouds));
    let rad_flux = 5.0 * (sky_temp - currentWaterTemp) * night_rad;
    
    let ground_flux = 3.0 * (15.0 - currentWaterTemp);

    let total_flux = solar_flux + conv_flux - evap_flux + rad_flux + ground_flux;
    return (total_flux * SURFACE * 3600) / (WATER_MASS * C_P);
}

function formatDate(daysAgo) {
    let d = new Date(Date.now() - (daysAgo * 86400000));
    let year = "" + d.getFullYear();
    let month = "" + (d.getMonth() + 1);
    if (month.length === 1) { month = "0" + month; }
    let day = "" + d.getDate();
    if (day.length === 1) { day = "0" + day; }
    return year + "-" + month + "-" + day;
}

function getDaysSinceFill() {
    let fillTime = new Date(FILL_DATE + "T00:00:00").getTime();
    let elapsedDays = Math.floor((Date.now() - fillTime) / 86400000);
    return elapsedDays < 0 ? 0 : elapsedDays;
}

function fetchHistoricalDay(remainingDays, estimatedTemp, onComplete) {
    if (remainingDays === 0) {
        log("[POOL_SCRIPT][fetchHistoricalDay] Initialization completed since " + FILL_DATE + ". Estimated temp: " + estimatedTemp);
        Shelly.call("KVS.Set", { key: KEY_POOL_TEMP, value: JSON.stringify(estimatedTemp) }, function() {
            Shelly.call("KVS.Set", { key: KEY_FILL_DATE, value: FILL_DATE }, function() {
                if (onComplete) { onComplete(); }
            });
        });
        return;
    }

    let dateStr = formatDate(remainingDays);
    let url = ARCHIVE_URL + "&start_date=" + dateStr + "&end_date=" + dateStr;

    Shelly.call("HTTP.GET", { url: url }, function(res, err) {
        if (err || !res || res.code !== 200) {
            let errorDetail = err ? err : (res ? "HTTP " + res.code : "No response");
            log("[POOL_SCRIPT][fetchHistoricalDay] Error for day " + dateStr + ": " + errorDetail + ". Retrying.");
            Timer.set(ARCHIVE_RETRY_DELAY_MS, false, function() { fetchHistoricalDay(remainingDays, estimatedTemp, onComplete); });
            return;
        }

        let data = JSON.parse(res.body);
        let dayStartTemp = estimatedTemp;
        if (data && data.hourly && data.hourly.temperature_2m) {
            let totalHours = data.hourly.time.length;
            for (let i = 0; i < totalHours; i++) {
                let hourlyWeather = {
                    temperature_2m: data.hourly.temperature_2m[i],
                    relative_humidity_2m: data.hourly.relative_humidity_2m[i],
                    wind_speed_10m: data.hourly.wind_speed_10m[i],
                    shortwave_radiation: data.hourly.shortwave_radiation[i],
                    cloud_cover: data.hourly.cloud_cover[i]
                };
                estimatedTemp += calculateHeatBalance(hourlyWeather, estimatedTemp);
            }
        }

                log("[POOL_SCRIPT][fetchHistoricalDay] Temperature delta: " + (estimatedTemp - dayStartTemp) + "°C" +
                            " | From: " + dayStartTemp + "°C | To: " + estimatedTemp + "°C");
        log("[POOL_SCRIPT][fetchHistoricalDay] Day " + dateStr + " processed. Current temp: " + Math.round(estimatedTemp * 100) / 100 + "°C (" + remainingDays + " days remaining)");

        Timer.set(200, false, function() {
            fetchHistoricalDay(remainingDays - 1, estimatedTemp, onComplete);
        });
    });
}

function scheduleFiltration(waterTemp, weatherData) {
    let airTemp = weatherData ? weatherData.temperature_2m : null;
    let windSpeed = weatherData ? weatherData.wind_speed_10m : 0;
    let freezeProtection = waterTemp <= FREEZE_PROTECTION_WATER_TEMP ||
        (airTemp !== null && airTemp <= FREEZE_PROTECTION_AIR_TEMP);

    if (freezeProtection) {
        return [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1];
    }

    let volumeTurnoverHours = VOLUME / PUMP_FLOW_M3H;
    let temperatureFactor = 1.0;

    if (waterTemp < 12) {
        temperatureFactor = 0.75;
    } else if (waterTemp < 16) {
        temperatureFactor = 0.9;
    } else if (waterTemp >= 24 && waterTemp < HEATWAVE_WATER_TEMP) {
        temperatureFactor = 1.25;
    } else if (waterTemp >= EXTREME_HEAT_WATER_TEMP ||
               (airTemp !== null && airTemp >= EXTREME_HEAT_AIR_TEMP)) {
        temperatureFactor = 2.0;
    } else if (waterTemp >= HEATWAVE_WATER_TEMP ||
               (airTemp !== null && airTemp >= HEATWAVE_AIR_TEMP)) {
        temperatureFactor = 1.5;
    }

    if (windSpeed >= HIGH_WIND_SPEED) temperatureFactor += 0.25;

    let allowedHours = [];
    for (let hour = 0; hour < 24; hour++) {
        let isQuietHour = QUIET_START_HOUR > QUIET_END_HOUR ?
            (hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR) :
            (hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR);
        if (!isQuietHour) allowedHours.push(hour);
    }

    let totalHours = Math.round(volumeTurnoverHours * TARGET_TURNOVERS * temperatureFactor);
    if (totalHours < MIN_FILTRATION_HOURS) totalHours = MIN_FILTRATION_HOURS;
    let effectiveMaxHours = Math.min(MAX_FILTRATION_HOURS, allowedHours.length);
    if (totalHours > effectiveMaxHours) totalHours = effectiveMaxHours;

    let schedule = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
    let isHotOrWindy = waterTemp >= HEATWAVE_WATER_TEMP ||
        (airTemp !== null && airTemp >= HEATWAVE_AIR_TEMP) ||
        windSpeed >= HIGH_WIND_SPEED;
    let windowStarts = isHotOrWindy ? [10, 13, 16, 19] : [8, 13, 17, 20];
    let remainingHours = totalHours;

    // Repartit la filtration dans des fenetres diurnes, avec des blocs de trois heures maximum.
    for (let windowIndex = 0; windowIndex < windowStarts.length && remainingHours > 0; windowIndex++) {
        let blockHours = Math.min(3, remainingHours);
        let startHour = windowStarts[windowIndex];
        for (let offset = 0; offset < blockHours; offset++) {
            let hour = startHour + offset;
            if (allowedHours.indexOf(hour) !== -1 && schedule[hour] === 0) {
                schedule[hour] = 1;
                remainingHours--;
            }
        }
    }

    // Secours si une configuration horaire supprime une fenetre preferee.
    for (let index = 0; index < allowedHours.length && remainingHours > 0; index++) {
        let hour = allowedHours[index];
        if (schedule[hour] === 0) {
            schedule[hour] = 1;
            remainingHours--;
        }
    }
    return schedule;
}

// ---------------------------------------------------------
// TASK EXECUTED EVERY MINUTE (Relay control + Hourly check)
// ---------------------------------------------------------
function tickEveryMinute() {
    if (resetComponent && isResetRequested(resetComponent.getValue())) {
        resetAndInitialize();
        return;
    }

    Shelly.call("KVS.Get", { key: KEY_POOL_TEMP }, function (resTemp, err) {
        if (err || resTemp === null || resTemp.value === undefined) {
            log("[POOL_SCRIPT][tickEveryMinute] Script currently performing historical initialization...");
            return; 
        }
        
        let waterTemp = Number(resTemp.value);
        let d = new Date();
        let currentHour = d.getHours();
        let currentMinute = d.getMinutes();
        let currentHourStr = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate() + "-" + currentHour;
        
        // 1. Update Virtual Components
        let poolTempVC = Virtual.getHandle("number:200");
        if (poolTempVC) poolTempVC.setValue(Math.round(waterTemp));
        
        // 2. Read Operating Mode
        let currentMode = "auto"; 
        let modeVC = Virtual.getHandle("text:200");
        if (modeVC) {
            let vcVal = modeVC.getValue();
            if (vcVal) {
                // Ensure lowercase for easy comparisons
                currentMode = vcVal.toLowerCase(); 
            }
        }

        // 3. Determine Relay State based on Mode
        let schedule = scheduleFiltration(waterTemp, latestWeatherData);
        let isAutoScheduledOn = (schedule[currentHour] === 1);
        let relayState = isAutoScheduledOn; // Default to 'auto' behavior

        if (currentMode === "on") {
            relayState = true;
        } else if (currentMode === "off") {
            relayState = false;
        } // if "auto", it simply stays as 'isAutoScheduledOn'

        // Apply physical state
        Shelly.call("Switch.Set", { id: 0, on: relayState });

        // HEARTBEAT LOG (Visual check for proper execution every minute)
        log("[POOL_SCRIPT][ALIVE] " + (currentHour < 10 ? "0" + currentHour : currentHour) + ":" + (currentMinute < 10 ? "0" + currentMinute : currentMinute) + 
              " | Temp: " + Math.round(waterTemp * 10) / 10 + "°C | Mode: [" + currentMode.toUpperCase() + "] | Relay: " + (relayState ? "ON" : "OFF") + " | " + JSON.stringify(schedule));

        // 4. Hour change detection to trigger weather update and thermal calculation
        Shelly.call("KVS.Get", { key: KEY_LAST_UPDATE_HOUR }, function (resHisto) {
            let lastRecordedHour = "";
            if (resHisto && resHisto.value !== undefined) {
                lastRecordedHour = JSON.parse(resHisto.value);
            }

            if (lastRecordedHour !== currentHourStr) {
                if (realtimeRequestInProgress) {
                    log("[POOL_SCRIPT][tickEveryMinute] Weather request already in progress, waiting for response.");
                    return;
                }

                realtimeRequestInProgress = true;
                log("[POOL_SCRIPT][tickEveryMinute] New hour detected (" + currentHour + "h): Starting thermal calculation.");
                
                Shelly.call("HTTP.GET", { url: REALTIME_URL, timeout: REALTIME_TIMEOUT_SECONDS }, function(resHttp, error) {
                    realtimeRequestInProgress = false;
                    if (error || !resHttp || resHttp.code !== 200) {
                        let errorDetail = error ? error : (resHttp ? "HTTP " + resHttp.code : "No response");
                        log("[POOL_SCRIPT][tickEveryMinute] Open-Meteo request failed: " + errorDetail);
                        return;
                    }

                    let data = JSON.parse(resHttp.body);
                    latestWeatherData = data.current;
                      log("[POOL_SCRIPT][Open-Meteo] Air: " + data.current.temperature_2m + "°C" +
                          " | Humidity: " + data.current.relative_humidity_2m + "%" +
                          " | Wind: " + data.current.wind_speed_10m + " km/h" +
                          " | Solar: " + data.current.shortwave_radiation + " W/m²" +
                          " | Clouds: " + data.current.cloud_cover + "%");
                    let delta_t = calculateHeatBalance(data.current, waterTemp);
                    let newWaterTemp = waterTemp + delta_t;
                    
                                            log("[POOL_SCRIPT][tickEveryMinute] Temperature delta: " + delta_t + "°C");
                                        log("[POOL_SCRIPT][tickEveryMinute] New calculated water temp: " + newWaterTemp);
                    
                    Shelly.call("KVS.Set", { key: KEY_POOL_TEMP, value: JSON.stringify(newWaterTemp) });
                    Shelly.call("KVS.Set", { key: KEY_LAST_UPDATE_HOUR, value: JSON.stringify(currentHourStr) });
                });
            }
        });
    });
}

// ---------------------------------------------------------
// SCRIPT STARTUP
// ---------------------------------------------------------
function startInitialization() {
    let initializationDays = getDaysSinceFill();
    log("[POOL_SCRIPT][Startup] Starting initialization since " + FILL_DATE + " (" + initializationDays + " days)...");
    fetchHistoricalDay(initializationDays, INITIAL_WATER_TEMP, function() {
        resetInProgress = false;
        log("[POOL_SCRIPT][Startup] Iniialization finished, activating minute timer.");
        mainTimer = Timer.set(60000, true, function () { tickEveryMinute(); });
    });
}

function resetAndInitialize() {
    if (resetInProgress) return;
    resetInProgress = true;
    log("[POOL_SCRIPT][Startup] Reset requested from Shelly Control.");
    if (mainTimer !== null) {
        Timer.clear(mainTimer);
        mainTimer = null;
    }
    if (resetComponent) {
        log("[POOL_SCRIPT][Startup] Reset command acknowledged, clearing KVS.");
        resetComponent.setValue(false);
    }

    Shelly.call("KVS.Delete", { key: KEY_POOL_TEMP }, function() {
        Shelly.call("KVS.Delete", { key: KEY_LAST_UPDATE_HOUR }, function() {
            Shelly.call("KVS.Delete", { key: KEY_FILL_DATE }, function() {
                log("[POOL_SCRIPT][Startup] KVS cleared, restarting initialization.");
                startInitialization();
            });
        });
    });
}

function startScript() {
    if (resetComponent && isResetRequested(resetComponent.getValue())) {
        resetAndInitialize();
        return;
    }

    Shelly.call("KVS.Get", { key: KEY_POOL_TEMP }, function (res, err) {
    if (err || res === null || res.value === undefined) {
        startInitialization();
    } else {
        Shelly.call("KVS.GET", { key: KEY_FILL_DATE }, function (fillDateResult) {
            if (!fillDateResult || fillDateResult.value !== FILL_DATE) {
                startInitialization();
                return;
            }

            log("[POOL_SCRIPT][Startup] Normal startup, activating minute timer.");
            mainTimer = Timer.set(60000, true, function () { tickEveryMinute(); });
            tickEveryMinute();
        });
    }
});
}

function isResetRequested(value) {
    return value === true || value === 1 || value === "true";
}

startScript();