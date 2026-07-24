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

// --- CONFIGURATION ---
let LENGTH = 10.0;
let WIDTH = 5.0;
let DEPTH = 1.5;
let COVER_TYPE = "enclosure"; // "none", "cover", "enclosure"
let LATITUDE = "43.4142"; // Navailles-Angos
let LONGITUDE = "-0.3417";
let INITIALIZATION_DAYS = 90;

let SURFACE = LENGTH * WIDTH;
let VOLUME = SURFACE * DEPTH;
let WATER_MASS = VOLUME * 1000;
let C_P = 4184;

let REALTIME_URL = "https://api.open-meteo.com/v1/forecast?latitude=" + LATITUDE + "&longitude=" + LONGITUDE + "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,shortwave_radiation,cloud_cover";

/**
 * Polynomial approximation of water saturation vapor pressure (in kPa).
 * 
 * Algorithm Description:
 * Shelly's mJS engine lacks native support for complex mathematical operations 
 * like exponential functions (Math.exp). To compute vapor pressure without 
 * performance bottlenecks, this function uses a calibrated 2nd-degree polynomial equation:
 * P(T) = 0.0046 * T^2 - 0.0327 * T + 1.094
 * This approximates the Magnus-Tetens formula accurately within typical swimming pool 
 * operating temperatures (10°C to 35°C).
 */
function approxVaporPressure(T) {
    return (0.0046 * T * T) - (0.0327 * T) + 1.094;
}

/**
 * Computes the global heat balance (flux in W/m²) and derives the water 
 * temperature variation (Delta T) for a one-hour period.
 * 
 * Algorithm Description:
 * 1. Environmental inputs (air temp, humidity, wind, solar radiation, cloud cover) are retrieved.
 * 2. Physical coefficients (wind reduction, solar transmission, evaporation, convection, 
 *    and infrared radiation) are dynamically adjusted based on the pool's protection type 
 *    (none, cover, or enclosure).
 * 3. Energy fluxes per square meter are calculated:
 *    - Solar Flux: Direct and diffuse shortwave energy absorbed by the water volume.
 *    - Convection Flux: Sensible heat exchange caused by direct contact between air and water/cover.
 *    - Evaporation Flux: Latent heat loss due to water vaporization at the surface, modulated 
 *      by the vapor pressure difference between water and air.
 *    - Radiation Flux: Longwave infrared emission lost to the open sky or trapped by the enclosure.
 *    - Ground Flux: Conduction losses/gains toward surrounding earth stabilized at ~15°C.
 * 4. The total net energy flux is converted into a temperature increment (Delta T) over 
 *    one hour (3600 seconds) using the mass of water and specific heat capacity (C_p).
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

    // 1. Gain from direct and diffuse solar radiation absorbed by water
    let solar_flux = solar_rad * solar_trans;
    
    // 2. Heat exchange via convection (direct contact with ambient air)
    let h_c = 3.1 + (4.1 * surface_wind);
    let conv_flux = h_c * (t_air - currentWaterTemp) * conv_coeff;

    // 3. Evaporation losses (major cooling factor at the water surface)
    let p_water = approxVaporPressure(currentWaterTemp);
    let p_air = (rh / 100.0) * approxVaporPressure(t_air);
    let evap_flux = evap_coeff * (25 + (19 * surface_wind)) * (p_water - p_air);
    if (evap_flux < 0) evap_flux = 0;

    // 4. Nighttime infrared radiation toward the sky / enclosure walls
    let sky_temp = t_air - (20 * (1 - clouds));
    let rad_flux = 5.0 * (sky_temp - currentWaterTemp) * night_rad;
    
    // 5. Thermal conductivity toward the surrounding ground (stabilized around ~15°C)
    let ground_flux = 3.0 * (15.0 - currentWaterTemp);

    // Total energy balance (Watts per square meter) converted into temperature variation (Delta T)
    let total_flux = solar_flux + conv_flux - evap_flux + rad_flux + ground_flux;
    return (total_flux * SURFACE * 3600) / (WATER_MASS * C_P);
}

/**
 * Formats a given date into a "YYYY-MM-DD" string format
 * to query Open-Meteo's historical API day by day.
 */
function formatDate(daysAgo) {
    let d = new Date(Date.now() - (daysAgo * 86400000));
    let year = "" + d.getFullYear();
    let month = "" + (d.getMonth() + 1);
    if (month.length === 1) { month = "0" + month; }
    let day = "" + d.getDate();
    if (day.length === 1) { day = "0" + day; }
    return year + "-" + month + "-" + day;
}

/**
 * Asynchronous recursive initialization algorithm:
 * Goes back in time day by day over the defined period to simulate thermal history
 * and estimate a realistic starting temperature without saturating Shelly's memory.
 */
function fetchHistoricalDay(remainingDays, estimatedTemp, onComplete) {
    if (remainingDays === 0) {
        print("[POOL_SCRIPT][fetchHistoricalDay] Initialization completed over " + INITIALIZATION_DAYS + " days! Estimated temp: " + estimatedTemp);
        Shelly.call("KVS.Set", { key: "pool_temp", value: JSON.stringify(estimatedTemp) }, function() {
            if (onComplete) { onComplete(); }
        });
        return;
    }

    let dateStr = formatDate(remainingDays);
    let url = "https://api.open-meteo.com/v1/forecast?latitude=" + LATITUDE + "&longitude=" + LONGITUDE + 
              "&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,shortwave_radiation,cloud_cover" + 
              "&start_date=" + dateStr + "&end_date=" + dateStr;

    Shelly.call("HTTP.GET", { url: url }, function(res, err) {
        if (err || res.code !== 200) {
            print("[POOL_SCRIPT][fetchHistoricalDay] Error for day " + dateStr + ", skipping.");
            Timer.set(200, false, function() { fetchHistoricalDay(remainingDays - 1, estimatedTemp, onComplete); });
            return;
        }

        let data = JSON.parse(res.body);
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

        print("[POOL_SCRIPT][fetchHistoricalDay] Day " + dateStr + " processed. Current temp: " + Math.round(estimatedTemp * 100) / 100 + "°C (" + remainingDays + " days remaining)");

        Timer.set(200, false, function() {
            fetchHistoricalDay(remainingDays - 1, estimatedTemp, onComplete);
        });
    });
}

/**
 * Calculates the required daily filtration runtime and generates an alternating 
 * hour-by-hour schedule (Strict 2h ON / 1h OFF alternation pattern) to protect the pump motor.
 * 
 * Algorithm Description:
 * 1. Runtime Determination:
 *    - If water temperature is < 12°C, sets runtime to 2 hours.
 *    - If water temperature is between 12°C and 16°C, sets runtime to 4 hours.
 *    - For higher temperatures, uses the standard rule of thumb: water temperature divided by 2 (e.g., 32°C -> 16 hours).
 *    - Applies safety bounds (minimum 2 hours, maximum 24 hours) and reduces runtime under an enclosure or cover if warm.
 * 2. Motor-Safe Alternating Schedule Generation (2h ON / 1h OFF blocks):
 *    - Creates an array of 24 hourly slots initialized to 0 (OFF).
 *    - Iterates through the day using 3-hour staggered slots (e.g., 8h-10h ON, with 11h serving as the 1h OFF cooling break) 
 *      to ensure the motor never runs continuously for excessive hours without a break.
 *    - Prioritizes daytime windows (starting around 8h) to capture peak solar radiation and UV impact, 
 *      then fills remaining required blocks across the rest of the schedule.
 */
function scheduleFiltration(waterTemp) {
    let totalHours = (waterTemp < 12) ? 2 : ((waterTemp < 16) ? 4 : Math.round(waterTemp / 2));
    if (COVER_TYPE === "enclosure" && waterTemp >= 24) {
        totalHours = Math.max(totalHours - 2, 8);
    } else if (COVER_TYPE === "cover") {
        totalHours = Math.max(totalHours - 1, 6);
    }
    if (totalHours > 24) totalHours = 24;
    if (totalHours < 2) totalHours = 2;

    let schedule = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
    
    // Slots spaced by 3 hours (2h ON + 1h natural OFF before the next block)
    let candidateSlots = [8, 11, 14, 17, 20, 5, 2]; 
    let blocksNeeded = Math.round(totalHours / 2);
    let blocksScheduled = 0;

    for (let i = 0; i < candidateSlots.length; i++) {
        if (blocksScheduled < blocksNeeded) {
            let h = candidateSlots[i];
            schedule[h] = 1;       // 1st hour of the ON block
            schedule[h + 1] = 1;   // 2nd hour of the ON block
            blocksScheduled++;
            // Hour h+2 automatically remains 0 (OFF), providing 1h of cooling rest before the next slot
        }
    }

    print("[POOL_SCRIPT][scheduleFiltration] Generated 2h ON / 1h OFF schedule (0-23h): " + JSON.stringify(schedule));
    return schedule;
}

// ---------------------------------------------------------
// TASK EXECUTED EVERY MINUTE (Relay control + Hourly check)
// ---------------------------------------------------------
function tickEveryMinute() {
    Shelly.call("KVS.Get", { key: "pool_temp" }, function (resTemp, err) {
        if (err || resTemp === null || resTemp.value === undefined) {
            print("[POOL_SCRIPT][tickEveryMinute] Script currently performing historical initialization...");
            return; 
        }
        
        let waterTemp = Number(resTemp.value);
        let d = new Date();
        let currentHour = d.getHours();
        let currentMinute = d.getMinutes();
        let currentHourStr = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate() + "-" + currentHour;

        // 1. Immediate relay control based on current hour and established schedule
        let schedule = scheduleFiltration(waterTemp);
        let shouldFilter = (schedule[currentHour] === 1);
        Shelly.call("Switch.Set", { id: 0, on: shouldFilter });

        // HEARTBEAT LOG (Visual check for proper execution every minute)
        print("[POOL_SCRIPT][tickEveryMinute][ALIVE] " + (currentHour < 10 ? "0" + currentHour : currentHour) + ":" + (currentMinute < 10 ? "0" + currentMinute : currentMinute) + 
              " | Water: " + Math.round(waterTemp * 10) / 10 + "°C | Filtration: " + (shouldFilter ? "RUNNING (ON)" : "STOPPED (OFF)"));

        // 2. Hour change detection to trigger weather update and thermal calculation
        Shelly.call("KVS.Get", { key: "last_update_hour" }, function (resHisto) {
            let lastRecordedHour = "";
            if (resHisto && resHisto.value !== undefined) {
                lastRecordedHour = JSON.parse(resHisto.value);
            }

            if (lastRecordedHour !== currentHourStr) {
                print("[POOL_SCRIPT][tickEveryMinute] New hour detected (" + currentHour + "h): Starting thermal calculation.");
                
                Shelly.call("HTTP.GET", { url: REALTIME_URL }, function (resHttp, error) {
                    if (error || resHttp.code !== 200) { return; }

                    let data = JSON.parse(resHttp.body);
                    let delta_t = calculateHeatBalance(data.current, waterTemp);
                    let newWaterTemp = waterTemp + delta_t;
                    
                    print("[POOL_SCRIPT][tickEveryMinute] New calculated water temp: " + newWaterTemp);
                    
                    Shelly.call("KVS.Set", { key: "pool_temp", value: JSON.stringify(newWaterTemp) });
                    Shelly.call("KVS.Set", { key: "last_update_hour", value: JSON.stringify(currentHourStr) });
                });
            }
        });
    });
}

// ---------------------------------------------------------
// SCRIPT STARTUP
// ---------------------------------------------------------
Shelly.call("KVS.Get", { key: "pool_temp" }, function (res, err) {
    if (err || res === null || res.value === undefined) {
        // First run: Full initialization over X days then activate minute timer
        print("[POOL_SCRIPT][Startup] Starting initialization over " + INITIALIZATION_DAYS + " days...");
        fetchHistoricalDay(INITIALIZATION_DAYS, 15.0, function() {
            print("[POOL_SCRIPT][Startup] Initialization finished, activating minute timer.");
            Timer.set(60000, true, function () { tickEveryMinute(); });
        });
    } else {
        // Normal startup (value already present in memory)
        print("[POOL_SCRIPT][Startup] Normal startup, activating minute timer.");
        Timer.set(60000, true, function () { tickEveryMinute(); });
        // Immediate execution of the first check
        tickEveryMinute();
    }
});
