# Shelly Scripts

A collection of Shelly IOT Devices scripts :
- **Scheduler.js** : a 24 hour schedule with 30' granularity and web admin panel. Very convenient for pools.
- **Boiler.js** : This Shelly script detects when an oil burner turns on and off using power consumption, measures its runtime, calculates fuel usage in centiliters, and continuously updates the remaining oil level in persistent storage
- **BoilerNTFY.js** : This Shelly script detects when an oil burner turns on and off using power consumption, measures its runtime, calculates fuel usage in centiliters, continuously updates the remaining oil level in persistent storage and send low level alerts via ntfy.sh topic
