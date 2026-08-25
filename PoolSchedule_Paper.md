# Sensorless Thermal Estimation and Autonomous Filtration Scheduling for Outdoor Swimming Pools

**Author:** Jean P. Cordeiro  
**Repository:** [myShelly on GitHub](https://github.com/JeanPCordeiro/myShelly)  
**Script Name:** `PoolSchedule.mjs`

---

## Abstract

This work presents a practical embedded approach for estimating pool water temperature and controlling filtration without direct physical temperature sensing. The implemented system, deployed as `PoolSchedule.mjs` on Shelly smart relay hardware, estimates thermal behavior using only Open-Meteo weather telemetry and a simplified energy-balance model. The architecture combines weather-driven thermal estimation, historical initialization, and a rule-based daily scheduling policy to regulate pool filtration cycles.

The proposed method avoids underwater probes and instead relies on a compact, interpretable model that incorporates ambient temperature, relative humidity, wind speed, solar radiation, cloud cover, and enclosure/cover conditions. The system is designed for low-resource edge execution, addressing the practical constraints of embedded hardware while preserving a physically consistent operational logic for water temperature estimation and pump control.

The results of the implementation demonstrate the feasibility of a sensorless thermostat-like control loop for residential pool maintenance, with emphasis on computational simplicity, deployment practicality, and operational reliability.

---

## 1. Introduction

The management of outdoor swimming pools is fundamentally a thermal-control problem. The pool temperature affects water comfort, sanitation, and energy efficiency, but direct measurement of water temperature often requires physical instrumentation inside the pool environment. Such sensors are vulnerable to chemical corrosion, scaling, electrical degradation, and installation complexity. These limitations create an operational motivation for virtual sensing strategies that estimate water temperature using external environmental information.

This study presents a system designed around the principle of sensorless thermal estimation. Rather than measuring the water directly, the algorithm infers the state of the pool using meteorological observations from an external API, then computes a temperature evolution model and converts the result into a filtration schedule. The design is intentionally pragmatic: it favors robustness, low computational cost, and compatibility with embedded smart-relay hardware over highly detailed fluid-dynamic simulation.

The implementation described here is expressly a field-deployable control strategy. It is not designed as a high-fidelity thermal simulator, but rather as an operational model that balances accuracy, computational tractability, and real-world reliability. The resulting controller embodies a hybrid solution: an environmental model for temperature estimation, an initialization procedure based on historical weather data, and a simple rule-based scheduler for relay activation.

---

## 2. System Architecture

The implementation consists of a single JavaScript script executed within the Shelly mJS runtime. The system is organized around four functional stages:

1. geometry and thermal parameter initialization,
2. weather retrieval from Open-Meteo,
3. hourly thermal state estimation,
4. relay scheduling and activation control.

The script defines a rectangular pool with the following geometric and thermal characteristics:

- `LENGTH = 10.0 m`
- `WIDTH = 5.0 m`
- `DEPTH = 1.5 m`
- `SURFACE = LENGTH * WIDTH = 50.0 m^2`
- `VOLUME = SURFACE * DEPTH = 75.0 m^3`
- `WATER_MASS = VOLUME * 1000 = 75,000 kg`
- `C_P = 4184 J/(kg·°C)`

These values define the mass and thermal capacity of the water body used in the estimation step. The pool is assumed to have a fixed geometry and constant water density, which is consistent with the intended operational scope of the controller.

The runtime system reads weather variables from Open-Meteo:

- air temperature,
- relative humidity,
- wind speed,
- shortwave radiation,
- cloud cover.

The execution loop stores the estimated water temperature in Shelly KVS memory and updates it each hour using the latest meteorological observation.

---

## 3. Methodology

### 3.1 Data Source and Input Processing

The system retrieves weather information from the Open-Meteo current-weather endpoint:

```javascript
let REALTIME_URL = "https://api.open-meteo.com/v1/forecast?latitude=" + LATITUDE + "&longitude=" + LONGITUDE + "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,shortwave_radiation,cloud_cover";
```

The script normalizes the incoming variables as follows:

```javascript
let t_air = weatherData.temperature_2m;
let rh = weatherData.relative_humidity_2m;
let wind_speed = weatherData.wind_speed_10m / 3.6;
let solar_rad = weatherData.shortwave_radiation;
let clouds = weatherData.cloud_cover / 100.0;
```

This conversion ensures that wind speed is expressed in m/s and cloud cover is expressed as a fraction in $[0, 1]$.

### 3.2 Thermal Model

The core thermal estimate is provided by `calculateHeatBalance(weatherData, currentWaterTemp)`. The algorithm defines a net energy flux that is converted to a temperature increment over one hour:

$$
\Delta T = \frac{\left( \text{total flux} \times \text{surface area} \times 3600 \right)}{\text{water mass} \times C_p}
$$

where `total flux` is the net exchange rate in W/m², and the denominator represents the thermal capacity of the pool water.

This formulation is intentionally simple and computationally light, combining the principal terms responsible for energy exchange:

- solar gain,
- convection,
- evaporation,
- night radiation,
- ground exchange.

The energy balance can therefore be represented conceptually as:

$$
\Delta T = \frac{\left[\text{solar} + \text{convection} - \text{evaporation} + \text{radiation} + \text{ground}\right] \cdot A \cdot 3600}{M \cdot C_p}
$$

where $A$ is the pool surface area and $M \cdot C_p$ is the total thermal capacity of the water volume.

### 3.3 Vapor Pressure Approximation

The script uses a simplified vapor-pressure approximation intended for low-resource execution within the Shelly mJS environment:

```javascript
function approxVaporPressure(T) {
    return (0.0046 * T * T) - (0.0327 * T) + 1.094;
}
```

This quadratic function approximates the water saturation vapor-pressure relationship in the relevant operating range for swimming pools. It is used to compute:

- `p_water = approxVaporPressure(currentWaterTemp)`
- `p_air = (rh / 100.0) * approxVaporPressure(t_air)`

The evaporative term is then estimated as the difference between the water-surface vapor pressure and the ambient vapor pressure. The script explicitly guards against negative evaporative fluxes by setting them to zero when the vapor-pressure difference is unfavorable.

### 3.4 Energy Exchange Components

The script defines a series of empirical exchange terms that are compatible with embedded execution.

#### Solar gain

```javascript
let solar_flux = solar_rad * solar_trans;
```

The solar term is proportional to the incoming shortwave radiation and is reduced according to cover or enclosure conditions.

#### Sensible convection

```javascript
let h_c = 3.1 + (4.1 * surface_wind);
let conv_flux = h_c * (t_air - currentWaterTemp) * conv_coeff;
```

This term represents heat exchange between the water surface and the surrounding air. The coefficient increases with wind speed and is damped under cover or enclosure conditions.

#### Evaporative cooling

```javascript
let p_water = approxVaporPressure(currentWaterTemp);
let p_air = (rh / 100.0) * approxVaporPressure(t_air);
let evap_flux = evap_coeff * (25 + (19 * surface_wind)) * (p_water - p_air);
if (evap_flux < 0) evap_flux = 0;
```

This component captures the dominant latent-loss mechanism for outdoor pools and depends on air humidity, temperature, and wind exposure.

#### Longwave radiative exchange

```javascript
let sky_temp = t_air - (20 * (1 - clouds));
let rad_flux = 5.0 * (sky_temp - currentWaterTemp) * night_rad;
```

This term approximates infrared cooling toward the sky and enclosure surfaces. Lower cloud cover is associated with stronger radiative cooling.

#### Ground exchange

```javascript
let ground_flux = 3.0 * (15.0 - currentWaterTemp);
```

This stabilizing conduction term accounts for heat exchange with the surrounding ground environment, fixed at a nominal temperature of 15°C.

The final net flux is then computed as:

```javascript
let total_flux = solar_flux + conv_flux - evap_flux + rad_flux + ground_flux;
return (total_flux * SURFACE * 3600) / (WATER_MASS * C_P);
```

---

## 4. Cover and Enclosure Effects

The system includes a protection mode parameter:

```javascript
let COVER_TYPE = "enclosure"; // "none", "cover", "enclosure"
```

It modifies the exchange coefficients according to the expected thermal environment:

```javascript
if (COVER_TYPE === "cover") {
    surface_wind = 0; solar_trans = 0.45; evap_coeff = 0.05; conv_coeff = 0.8; night_rad = 0.9;      
} else if (COVER_TYPE === "enclosure") {
    surface_wind = 0.1; solar_trans = 0.35; evap_coeff = 0.40; conv_coeff = 0.6; night_rad = 0.1;      
}
```

These adjustments reflect the physical expectation that covers and enclosures reduce wind-driven evaporation and alter solar gains while changing the radiative and convective exchange regime. In practical deployment, these parameters act as a low-order tuning layer for the specific pool configuration.

---

## 5. Historical Initialization and State Estimation

A key challenge for embedded systems is the absence of an initial measured water-temperature state. To address this, the script performs a historical initialization over a 90-day window using consecutive daily weather data. This process is implemented recursively:

```javascript
function fetchHistoricalDay(remainingDays, estimatedTemp, onComplete) {
    if (remainingDays === 0) {
        Shelly.call("KVS.Set", { key: "pool_temp", value: JSON.stringify(estimatedTemp) }, function() {
            if (onComplete) { onComplete(); }
        });
        return;
    }
```

The script iterates through hourly weather records and integrates the thermal model for each hour, effectively reconstructing a plausible thermal history. This is stored in the Shelly KVS and later used as the initial temperature state for real-time control.

This initialization step is essential for ensuring the controller begins with a realistic water temperature rather than an arbitrary default value.

---

## 6. Control Strategy: Filtration Scheduling

The system does not merely estimate temperature; it uses the estimate to decide when to run filtration. The scheduler computes the daily runtime requirement by applying a simple decision policy based on water temperature:

```javascript
function scheduleFiltration(waterTemp) {
    let totalHours = (waterTemp < 12) ? 2 : ((waterTemp < 16) ? 4 : Math.round(waterTemp / 2));
    if (COVER_TYPE === "enclosure" && waterTemp >= 24) {
        totalHours = Math.max(totalHours - 2, 8);
    } else if (COVER_TYPE === "cover") {
        totalHours = Math.max(totalHours - 1, 6);
    }
    if (totalHours > 24) totalHours = 24;
    if (totalHours < 2) totalHours = 2;
```

The schedule is then built as a repeating 2-hour ON / 1-hour OFF pattern across the day. The design rationale is operational and protective: the controller prioritizes a realistic filtration load while respecting the motor cycling constraints of the relay and pump system.

The generated schedule is then applied as:

```javascript
let shouldFilter = (schedule[currentHour] === 1);
Shelly.call("Switch.Set", { id: 0, on: shouldFilter });
```

This yields a deterministic control loop that is simple to implement and robust to embedded runtime constraints.

---

## 7. Results and Practical Evaluation

The implementation demonstrates the feasibility of a sensorless, cloud-assisted thermal-control architecture for outdoor pools. The algorithm behaves consistently with the expected physical principles:

- warm ambient conditions and high solar radiation increase the estimated water temperature,
- high humidity and wind increase evaporative cooling,
- clear skies enhance longwave radiative losses,
- cover and enclosure conditions dampen exchange rates and reduce filtration demand.

The system also shows a useful operational property: it is resilient to absent direct water-temperature instrumentation while remaining readable, adjustable, and technically transparent. This is particularly valuable in embedded control contexts, where deterministic execution and maintainability are often more important than high-order physical fidelity.

In practice, the controller produces a stable feedback loop in which the relay schedule is continuously updated according to evolving environmental conditions. The method is therefore suitable for small-scale residential pool automation, especially where sensor maintenance, wiring complexity, or installation cost is a limiting factor.

---

## 8. Discussion

This implementation is intentionally not a full thermodynamic or computational-fluid-dynamics model. Instead, it occupies the middle ground between engineering heuristic control and process-level environmental modeling. The result is a controlled approximation designed for embedded reliability and low computational complexity.

The principal strengths of the method are its simplicity, transparency, and compatibility with low-power edge devices. It avoids challenging hardware dependencies, reduces installation overhead, and yields a clear control logic that can be inspected and tuned by end users.

The limitations are equally clear. Because the model uses a simplified vapor-pressure approximation, fixed geometry, and empirical exchange coefficients, its predictive accuracy will vary with pool size, local microclimate, and the presence of shading or water treatment chemicals. It is therefore best understood as an operational estimator rather than a precision laboratory model.

Nevertheless, for applications where the objective is efficient, low-maintenance automation instead of exact thermodynamic reconstruction, the approach offers a credible and practical solution.

---

## 9. Conclusion

This work presents a sensorless thermal estimation and filtration scheduling system for outdoor swimming pools, implemented as `PoolSchedule.mjs` on Shelly hardware. The system demonstrates that operational pool control can be achieved without direct water-temperature sensing by combining external meteorological data, a compact energy-balance model, and a rule-based relay schedule.

The implementation is especially relevant in residential contexts where low-cost automation is required, maintenance of submerged sensors is undesirable, and embedded devices must operate within strict computational constraints. The method provides a practical balance between physical plausibility, engineering simplicity, and maintainability.

Future work may include improved parameter calibration, adaptive coefficient tuning, and integration with more detailed environmental models. However, the current architecture already demonstrates that a cloud-assisted, sensorless control model can provide a viable foundation for autonomous pool filtration management.

---

## 10. Summary of Scientific Contribution

The scientific contribution of this work is not the derivation of a high-fidelity pool-physics model, but the demonstration that a compact, edge-computable, weather-driven controller can realistically approximate pool thermal behavior and automate filtration control without direct physical sensing. This makes the design relevant to embedded automation, demand-response control, and low-maintenance environmental monitoring in residential and light commercial pool systems.
