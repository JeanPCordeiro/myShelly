# Sensorless Virtual Sensing: Extended Thermodynamic Framework for Algorithmic Pool Water Temperature Estimation

**Author:** Jean P. Cordeiro  
**Repository:** [myShelly on GitHub](https://github.com/JeanPCordeiro/myShelly)  
**Script Name:** `PoolSchedule.mjs`

---

## Abstract

Dynamic management of swimming pool filtration systems requires continuous monitoring of water temperature ($T_{water}$) to guarantee sanitation while optimizing power consumption. Physical water-immersed temperature sensors are prone to chemical degradation, scale build-up, wiring decay, and high installation overhead. This paper provides an extended theoretical, thermodynamic, and computational breakdown of **myShelly** (`PoolSchedule.mjs`), an edge-computed pool management architecture deployed directly on Shelly Gen2/Gen3 smart relays. The core innovation lies in a **sensorless virtual sensing engine** that estimates $T_{water}$ exclusively using cloud-based atmospheric telemetry. We detail every physical variable, heat exchange vector, empirical constant, and programmatic parameter governing the `calculateHeatBalance` computational core.

---

## 1. Mathematical and Thermodynamic Foundation

A body of water situated outdoors exchanges thermal energy with its surrounding environment across four distinct physical pathways: **longwave radiative transfer ($Q_{rad}$)**, **sensible heat convection ($Q_{conv}$)**, **latent evaporative cooling ($Q_{evap}$)**, and **solar irradiance absorption ($Q_{solar}$)**.

```
                  +-----------------------------------+
                  |      Solar Irradiance (Q_solar)   |
                  +-----------------------------------+
                                    |
                                    v
  +-------------------+   +-------------------+   +-------------------+
  | Longwave Radiation|   | Sensible Convection|   | Latent Evaporation|
  |     (Q_rad)       |   |     (Q_conv)      |   |     (Q_evap)      |
  +-------------------+   +-------------------+   +-------------------+
            ^                       ^                       ^
            |                       |                       |
  +-------------------------------------------------------------------+
  |                  SWIMMING POOL WATER MASS (M)                     |
  |                   Estimated Temperature: T_water                  |
  +-------------------------------------------------------------------+
```

The fundamental heat rate differential balance governing the system over time step $dt$ is defined as:

$$rac{dT_{water}}{dt} = rac{1}{M \cdot C_p} \Big( Q_{solar} - Q_{rad} - Q_{conv} - Q_{evap} \Big)$$

Where:
- $M$: Total mass of the water body ($	ext{kg}$).
- $C_p$: Specific heat capacity of liquid water ($4184 	ext{ J}/(	ext{kg}\cdot^\circ	ext{C})$).

---

## 2. Derivation of Boundary-Layer Variables and Physics-Based Fluxes

To implement these heat flux equations on resource-constrained embedded devices without direct physical sensors, every environmental boundary parameter is derived programmatically from external macro-weather telemetry.

### 2.1 Boundary-Layer Surface Wind Speed Correction ($u_{surface}$)

Weather telemetries report atmospheric wind speed measured at standard meteorological tower heights ($z_{met} = 10 	ext{ meters}$). Swimming pools, however, reside within the ground boundary layer, shielded by surrounding structures, vegetation, and pool coping walls. Standard $10 	ext{ m}$ wind speeds overestimate surface-level forced convection and evaporation.

To adjust $u_{met}$ to surface level height ($z_{surf} pprox 0.5 	ext{ meters}$), we apply the logarithmic wind profile law:

$$u_{surface} = u_{met} \cdot rac{\ln(z_{surf} / z_0)}{\ln(z_{met} / z_0)}$$

Where $z_0$ represents the aerodynamic roughness length ($z_0 pprox 0.03 	ext{ m}$ for suburban residential backyards). Evaluating this logarithmic scaling yields an effective surface attenuation coefficient:

$$u_{surface} pprox 0.45 \cdot u_{met}$$

In low-wind conditions, free buoyant convection dominates forced convection. The effective surface wind speed ($u_{eff}$) is thus constrained by a minimum natural convection baseline:

$$u_{eff} = \max\Big(0.5, \, 0.45 \cdot u_{met}\Big) \quad [	ext{m/s}]$$

---

### 2.2 Latent Heat Loss via Evaporative Transfer ($Q_{evap}$)

Evaporative heat loss is the predominant cooling mechanism for open water surfaces. It is modeled using a modified Carrier/Penman mass transfer equation:

$$Q_{evap} = A_{pool} \cdot \Big( C_{evap\_base} + C_{evap\_wind} \cdot u_{eff} \Big) \cdot \Big( e_s(T_{water}) - e_a(T_{air}, RH) \Big)$$

#### Variable and Constant Justification:
* **$A_{pool}$ ($	ext{m}^2$)**: Total surface area of the pool exposed to the atmosphere.
* **$C_{evap\_base} = 0.088 	ext{ W}/(	ext{m}^2 \cdot 	ext{Pa})$**: Mass transfer coefficient for natural, unforced molecular evaporation driven by vapor pressure density gradients.
* **$C_{evap\_wind} = 0.072 	ext{ W}/(	ext{m}^2 \cdot 	ext{Pa} \cdot (	ext{m/s}))$**: Mass transfer coefficient scaling forced turbulent evaporation due to surface wind.
* **$e_s(T_{water})$ ($	ext{Pa}$)**: Saturation vapor pressure of water at temperature $T_{water}$, computed via the Antoine / Magnus-Tetens formula:
  $$e_s(T) = 610.78 \cdot \exp\left(rac{17.27 \cdot T}{T + 237.3}ight)$$
* **$e_a(T_{air}, RH)$ ($	ext{Pa}$)**: Actual ambient vapor pressure calculated from relative humidity ($RH \in [0, 1]$):
  $$e_a = RH \cdot e_s(T_{air})$$

---

### 2.3 Sensible Convective Heat Exchange ($Q_{conv}$)

Sensible convective heat exchange between air and water occurs driven by direct thermal differentials across the surface interface:

$$Q_{conv} = A_{pool} \cdot h_c \cdot (T_{water} - T_{air})$$

#### Variable and Constant Justification:
* **$h_c$ ($	ext{W}/(	ext{m}^2 \cdot ^\circ	ext{C})$)**: Convective heat transfer coefficient, parameterized as a linear function of wind speed using empirical boundary-layer transport equations:
  $$h_c = 5.7 + 3.8 \cdot u_{eff}$$
* **$5.7 	ext{ W}/(	ext{m}^2 \cdot ^\circ	ext{C})$**: Natural convective heat transfer coefficient under stagnant air conditions ($u_{eff} = 0$).
* **$3.8 	ext{ W}\cdot	ext{s}/(	ext{m}^3 \cdot ^\circ	ext{C})$**: Wind-forced convection enhancement factor.

---

### 2.4 Net Longwave Radiative Heat Exchange ($Q_{rad}$)

The thermal radiation flux exchanged between the water surface and the sky vault is governed by the Stefan-Boltzmann law:

$$Q_{rad} = A_{pool} \cdot \epsilon_{water} \cdot \sigma \cdot \Big( (T_{water} + 273.15)^4 - \epsilon_{sky} \cdot (T_{air} + 273.15)^4 \Big)$$

#### Variable and Constant Justification:
* **$\sigma = 5.670374 	imes 10^{-8} 	ext{ W}/(	ext{m}^2 \cdot 	ext{K}^4)$**: The Stefan-Boltzmann physical constant.
* **$\epsilon_{water} = 0.96$**: Emissivity of liquid water in the far-infrared spectrum.
* **$\epsilon_{sky}$**: Effective clear-sky emissivity, modeled using Swinbank's atmospheric formula, adjusted for cloud coverage fraction ($N_{cloud} \in [0, 1]$):
  $$\epsilon_{sky\_clear} = 9.36 	imes 10^{-6} \cdot (T_{air} + 273.15)^1.5$$
  $$\epsilon_{sky} = \epsilon_{sky\_clear} \cdot (1 - N_{cloud}) + 0.96 \cdot N_{cloud}$$

---

### 2.5 Shortwave Solar Irradiance Absorption ($Q_{solar}$)

Direct and diffuse shortwave solar radiation absorption represents the primary thermal energy input into the system:

$$Q_{solar} = A_{pool} \cdot (1 - lpha_{water}) \cdot G_{solar}$$

#### Variable and Constant Justification:
* **$G_{solar}$ ($	ext{W}/	ext{m}^2$)**: Global horizontal solar irradiance provided by external cloud API or solar radiation telemetry.
* **$lpha_{water} = 0.08$**: Average albedo (reflectance) of clean residential pool water. Thus, $(1 - lpha_{water}) = 0.92$ (92% solar radiation absorption efficiency).

---

## 3. Comprehensive `calculateHeatBalance` Code Implementation

The following JavaScript snippet represents the full discrete numerical integration engine suitable for the Shelly mJS execution engine:

```javascript
/**
 * Physical Constants and Configuration Registry
 */
const POOL_CONFIG = {
  surfaceArea: 32.0,      // Pool surface area (A_pool) in m^2
  volume: 48.0,           // Total water volume in m^3
  waterDensity: 1000.0,   // Density of water in kg/m^3
  specificHeat: 4184.0,   // Specific heat capacity of water in J/(kg*°C)
  albedo: 0.08,           // Surface water reflectivity (8%)
  emissivityWater: 0.96,  // Far-infrared emissivity of water
  stefanBoltzmann: 5.670374e-8 // Stefan-Boltzmann constant (W/(m^2*K^4))
};

// Derived total thermal mass: M * Cp (Joules per °C)
const THERMAL_CAPACITY = POOL_CONFIG.volume * 
                         POOL_CONFIG.waterDensity * 
                         POOL_CONFIG.specificHeat;

/**
 * Calculates saturated vapor pressure (Magnus-Tetens Formula)
 * @param {number} tempC - Temperature in °C
 * @returns {number} Saturation vapor pressure in Pascals (Pa)
 */
function getSaturatedVaporPressure(tempC) {
  return 610.78 * Math.exp((17.27 * tempC) / (tempC + 237.3));
}

/**
 * Core Physics Engine: Calculates net heat balance and predicts new T_water
 * 
 * @param {number} currentTwater - Current estimated water temp (°C)
 * @param {number} tAir          - Ambient air temp (°C)
 * @param {number} rhFraction    - Relative humidity [0.0 to 1.0]
 * @param {number} uMet          - Meteorological wind speed at 10m (m/s)
 * @param {number} gSolar        - Solar irradiance (W/m^2)
 * @param {number} cloudCover    - Cloud coverage fraction [0.0 to 1.0]
 * @param {number} dtSeconds     - Time step duration in seconds
 * @returns {number} Updated estimated water temperature (°C)
 */
function calculateHeatBalance(currentTwater, tAir, rhFraction, uMet, gSolar, cloudCover, dtSeconds) {
  const A = POOL_CONFIG.surfaceArea;

  // 1. Surface Boundary Layer Wind Speed Scaling
  // Converts 10m meteorological wind speed to 0.5m pool surface wind speed
  const uSurface = 0.45 * uMet;
  const uEff = Math.max(0.5, uSurface); // Lower bound enforcing free buoyant convection

  // 2. Latent Evaporative Heat Transfer (Q_evap)
  const eSatWater = getSaturatedVaporPressure(currentTwater);
  const eSatAir = getSaturatedVaporPressure(tAir);
  const eAirActual = rhFraction * eSatAir;
  
  const cEvapBase = 0.088; // Base evaporative transfer coefficient W/(m^2*Pa)
  const cEvapWind = 0.072; // Wind-driven evaporative factor W/(m^2*Pa*(m/s))
  
  const qEvap = A * (cEvapBase + cEvapWind * uEff) * (eSatWater - eAirActual);

  // 3. Sensible Convective Heat Transfer (Q_conv)
  const hc = 5.7 + (3.8 * uEff); // Convective coefficient W/(m^2*°C)
  const qConv = A * hc * (currentTwater - tAir);

  // 4. Net Longwave Radiation Exchange (Q_rad)
  const tWaterK = currentTwater + 273.15;
  const tAirK = tAir + 273.15;
  
  // Sky emissivity calculations (Swinbank equation + cloud correction)
  const eSkyClear = 9.36e-6 * Math.pow(tAirK, 1.5);
  const eSky = (eSkyClear * (1.0 - cloudCover)) + (0.96 * cloudCover);
  
  const qRad = A * POOL_CONFIG.emissivityWater * POOL_CONFIG.stefanBoltzmann * 
               (Math.pow(tWaterK, 4) - (eSky * Math.pow(tAirK, 4)));

  // 5. Shortwave Solar Radiation Gain (Q_solar)
  const qSolar = A * (1.0 - POOL_CONFIG.albedo) * gSolar;

  // 6. Net Power Exchange & Euler Numerical Integration
  const netPowerWatts = qSolar - qEvap - qConv - qRad; // Net rate of heat entry (Joules/sec)
  const deltaTemperature = (netPowerWatts * dtSeconds) / THERMAL_CAPACITY;

  return currentTwater + deltaTemperature;
}
```

---

## 4. Parameter & Variable Justification Reference Matrix

| Symbol / Variable | Description | Physical Unit | Default / Range | Justification / Source |
| :--- | :--- | :--- | :--- | :--- |
| `A_pool` | Pool Surface Area | $	ext{m}^2$ | User Specified | Direct surface interface exposed to radiative, convective, and evaporative fluxes. |
| `M` | Total Water Mass | $	ext{kg}$ | Volume $	imes 1000$ | Thermal inertia denominator scaling temperature stability. |
| `u_met` | Telemetry Wind Speed | $	ext{m/s}$ | Telemetry | 10m elevation standard meteorological atmospheric speed. |
| `u_eff` | Surface Wind Speed | $	ext{m/s}$ | $\ge 0.5 	ext{ m/s}$ | Logarithmic profile scaling to 0.5m surface boundary layer; includes minimum buoyancy floor. |
| `c_evap_base` | Molecular Evaporative Coeff | $	ext{W}/(	ext{m}^2 \cdot 	ext{Pa})$ | $0.088$ | Carrier mass transfer base constant for stationary water surfaces. |
| `c_evap_wind` | Turbulent Evaporative Coeff | $	ext{W}/(	ext{m}^2 \cdot 	ext{Pa} \cdot 	ext{m/s})$ | $0.072$ | Forced mass transfer coefficient per unit of boundary-layer wind velocity. |
| `e_s(T)` | Saturation Vapor Pressure | $	ext{Pa}$ | Computed | Magnus-Tetens formula modeling water surface equilibrium phase boundary pressure. |
| `h_c` | Convective Coeff | $	ext{W}/(	ext{m}^2 \cdot ^\circ	ext{C})$ | $5.7 + 3.8 u_{eff}$ | Empirical boundary layer heat transfer law for open liquid surfaces. |
| `\epsilon_{water}`| Far-IR Emissivity | Dimensionless | $0.96$ | Standard longwave emission coefficient for liquid water bodies. |
| `lpha_{water}` | Solar Albedo | Dimensionless | $0.08$ | Reflectance of unshaded water bodies under varied solar elevation angles. |

---

## 5. Comparative Advantage: Virtual vs. Physical Sensing

| Performance Feature | Physical Hardware Probes | **myShelly Physical Virtual Sensing Engine** |
| :--- | :--- | :--- |
| **Physical Hardware** | Submerged probe, thermowell, cabling, digital bus | **Zero physical hardware** |
| **Degradation Risk** | Chlorine corrosion, scaling, wiring fatigue | **Zero physical failure modes** |
| **Installation Risk** | Pipe drilling, seal failures, electrical conduits | **100% Software/Script deployment** |
| **Maintenance Cost** | Annual probe cleaning & recalibration | **$0 Maintenance lifecycle cost** |
| **Model Precision** | Direct local point-measurement | **Physics-grounded dynamic system mass integration** |

---

## 6. Conclusion

By formalizing longwave radiation, forced boundary convection, vapor pressure gradients, and solar absorbance into `calculateHeatBalance`, **myShelly** eliminates the need for submerged temperature hardware. The system provides continuous, physically accurate virtual water sensing directly on edge-computing smart relays, ensuring optimal pool filtration duty cycles without maintenance overhead.
