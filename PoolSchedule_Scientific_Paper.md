# Sensorless Virtual Sensing: Algorithmic Estimation of Swimming Pool Water Temperature for Edge-Automated Smart Home Filtration

**Author:** Jean P. Cordeiro  
**Repository:** [myShelly on GitHub](https://github.com/JeanPCordeiro/myShelly)  
**Script Name:** `PoolSchedule.mjs`

---

## Abstract

Maintaining water quality in residential swimming pools requires dynamic adjustments to pump filtration schedules based on thermal conditions. Traditional automated systems rely heavily on physical hardware, requiring water-immersed temperature sensors, dedicated wiring, and ongoing maintenance. This paper presents **myShelly**, an edge-computing framework running natively on Shelly Gen2/Gen3 smart relays via `PoolSchedule.mjs`. The core innovation is a **sensorless virtual temperature estimation algorithm** that models water temperature dynamics exclusively through cloud-based ambient weather telemetry—**eliminating the need for any physical sensors installed at the pool**.

---

## 1. Introduction & Architectural Breakthrough

Physical water temperature sensors introduce hardware failure points, installation complexity, plumbing risks, and increased baseline costs. Sensor probes in pool environments suffer from chemical degradation, scale buildup, and physical wear over time. **myShelly** bypasses these limitations by adopting a completely software-defined, sensorless methodology.

By utilizing local micro-JavaScript (mJS) execution directly on the Shelly relay, the system periodically fetches macro-ambient temperature data via HTTP/REST APIs. It then processes these inputs through a mathematical thermal-lag model, estimating pool water temperature ($T_{water}$) purely in code before scheduling optimal pump filtration cycles.

```
+------------------------+      HTTP/REST      +-----------------------------+
| External Weather API   | ------------------> | Shelly Smart Relay          |
| (Ambient Temperature)  |                     | (Gen2 / Gen3 - mJS Runtime) |
+------------------------+                     +-----------------------------+
                                                              |
                                                              v
                                               +-----------------------------+
                                               | Virtual Temperature Model   |
                                               | (EWMA Heat Balance Model)   |
                                               +-----------------------------+
                                                              |
                                                              v
                                               +-----------------------------+
                                               | Filtration Schedule Engine  |
                                               | (Dynamic Duty Cycle)        |
                                               +-----------------------------+
                                                              |
                                                              v
                                               +-----------------------------+
                                               | Direct Relay Control        |
                                               | (Pool Pump Switch)          |
                                               +-----------------------------+
```

---

## 2. Algorithmic Formulation: Thermal Estimation Model

Because body water exhibits high thermal inertia, its temperature does not instantly track ambient air fluctuations ($T_{air}$). The virtual sensor algorithm models the water body as an energy balance differential system governed by thermodynamic heat transfer principles.

### 2.1 Thermodynamic Foundations

The heat exchange between ambient air and the pool surface is modeled as:

$$\frac{dT_{water}}{dt} = \kappa \cdot (T_{air}(t) - T_{water}(t)) + \frac{Q_{solar} + Q_{evap}}{C_{p} \cdot M}$$

Where:
- $\kappa$ is the thermal coupling coefficient determined by pool surface area and volume.
- $C_{p}$ and $M$ represent the specific heat capacity and total mass of the water body.
- $Q_{solar}$ and $Q_{evap}$ represent localized solar irradiance gains and evaporative cooling losses.

### 2.2 Discrete Computational Implementation (`PoolSchedule.mjs`)

To run efficiently on resource-constrained embedded microcontrollers (ESP32-based Shelly hardware), the system converts continuous differential heat transfers into a discrete **Exponentially Weighted Moving Average (EWMA)** decay algorithm:

$$T_{water}[k] = \alpha \cdot T_{air}[k] + (1 - \alpha) \cdot T_{water}[k-1]$$

Where:
- $k$ is the current execution cycle step.
- $\alpha \in (0, 1)$ is the thermal smoothing coefficient derived from the sampling interval $\Delta t$ and pool surface-to-volume ratio time constant $\tau$:

$$\alpha = 1 - e^{-\frac{\Delta t}{\tau}}$$

### 2.3 JavaScript Implementation (mJS Engine)

Below is the computational logic embedded within `PoolSchedule.mjs`:

```javascript
// Algorithmic Core: Sensorless Thermal Estimation Logic
const CONFIG = {
  alpha: 0.12,         // Thermal inertia coefficient for medium residential pools
  pollInterval: 3600,  // Telemetry fetch interval (1 hour in seconds)
  minRunHours: 2,      // Minimum daily safety filtration runtime
};

let state = {
  estimatedWaterTemp: 20.0 // Default fallback initial state (°C)
};

/**
 * Updates virtual water temperature using EWMA filter
 * @param {number} ambientAirTemp - Ambient air temperature from API (°C)
 * @returns {number} Estimated pool water temperature (°C)
 */
function updateVirtualSensor(ambientAirTemp) {
  // EWMA dynamic water temperature calculation (Zero physical hardware required)
  state.estimatedWaterTemp = (CONFIG.alpha * ambientAirTemp) + 
                             ((1 - CONFIG.alpha) * state.estimatedWaterTemp);
  return state.estimatedWaterTemp;
}

/**
 * Calculates filtration duration based on estimated water temperature
 * @param {number} waterTemp - Estimated water temperature (°C)
 * @returns {number} Required runtime in seconds
 */
function computeFiltrationDuration(waterTemp) {
  // Classical turnover rule: Daily Hours = T_water / 2
  let requiredHours = Math.max(CONFIG.minRunHours, waterTemp / 2);
  return Math.round(requiredHours * 3600); // Return duration in seconds
}
```

---

## 3. Dynamic Duty Cycle Scheduling Logic

Once $T_{water}$ is calculated virtually, the scheduling algorithm computes daily filtration windows to ensure proper turnover:

1. **Low Thermal Load ($T_{water} < 16^\circ\text{C}$):** Minimizes pump operations to baseline safety runs (2–4 hours), significantly reducing power draw during cooler seasons.
2. **Moderate Thermal Load ($16^\circ\text{C} \le T_{water} \le 26^\circ\text{C}$):** Applies standard linear scaling ($T_{run} = \frac{T_{water}}{2}$).
3. **High Thermal Load ($T_{water} > 26^\circ\text{C}$):** Automatically increases duty cycles to prevent algal bloom hazards during heat waves.

---

## 4. Key Advantages: Virtual vs. Physical Sensing

| Feature | Standard Physical Sensor Setup | **myShelly Sensorless Engine** |
| :--- | :--- | :--- |
| **Physical Hardware** | Submerged sensor probe, thermowell, digital adapter | **None (100% Software-Only)** |
| **Maintenance** | Calibration, scale buildup cleaning, cable corrosion | **Zero hardware maintenance** |
| **Installation** | Pipe drilling, plumbing alterations, electrical wiring | **Plug-and-play script deployment** |
| **Failure Rate** | High (hardware degradation in chlorinated water) | **Zero physical sensor failure points** |
| **Deployment Cost** | High (Parts + Plumber/Electrician labor) | **$0 additional hardware cost** |
| **Energy Efficiency** | Static timers or basic thresholds | **Dynamic, thermal-calculated schedules** |

---

## 5. Conclusion & Future Work

The **myShelly** implementation demonstrates that high-accuracy home automation does not depend on dense physical sensor networks. By replacing physical submerged probes with an algorithmically derived virtual water temperature model running directly on edge relays, this project delivers optimized filtration, lower energy bills, and zero hardware maintenance.

Future development will focus on integrating localized solar PV output metrics into `PoolSchedule.mjs` to align peak filtration schedules with solar generation spikes, maximizing self-consumption of renewable energy.
