// Import shapefile for country boundaries
var filteredCountries = ee.FeatureCollection("projects/ee-testing-casa-25/assets/Nepal_boundary");
Map.centerObject(filteredCountries, 7);

// DEM
var dem = ee.Image('USGS/SRTMGL1_003');
var clippedDem = dem.clip(filteredCountries);

// Variable 1: SLOPE
var slope = ee.Terrain.slope(clippedDem);
var minMaxSlope = slope.reduceRegion({
  reducer: ee.Reducer.minMax(),
  geometry: filteredCountries.geometry(),
  scale: 250,
  bestEffort: true
});
var minSlope = ee.Number(minMaxSlope.get('slope_min'));
var maxSlope = ee.Number(minMaxSlope.get('slope_max'));
print("Min Slope:", minSlope);
print("Max Slope:", maxSlope);
var normSlope = slope.subtract(minSlope).divide(maxSlope.subtract(minSlope));
Map.addLayer(normSlope, {min: 0, max: 1, palette: ['white', 'blue', 'green', 'yellow', 'red']}, 'Nomalised Slope', false);

// Variable 2: ELEVATION
var elev = clippedDem;
var minMaxElevation = elev.reduceRegion({
  reducer: ee.Reducer.minMax(),
  geometry: filteredCountries.geometry(),
  scale: 250,
  bestEffort: true
});
var minElev = ee.Number(minMaxElevation.get('elevation_min'));
var maxElev = ee.Number(minMaxElevation.get('elevation_max'));
print("Min Elevation (m):", minElev);
print("Max Elevation (m):", maxElev);
var normElev = elev.subtract(minElev).divide(maxElev.subtract(minElev));
Map.addLayer(normElev, {min: 0, max: 1, palette: ['white', 'blue', 'green', 'yellow', 'red']}, 'Nomalised Elevation', false);

// Variable 3: MODIS land cover type and reclassification
var landcover = ee.ImageCollection("MODIS/061/MCD12Q1")
  .select("LC_Type1")
  .filterDate("2023-01-01", "2023-12-31")
  .first()
  .clip(filteredCountries);

var reclassifiedLand = landcover.remap(
  [0, 15, 11, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 13, 17],
  [0, 0, 0.1, 0.1, 0.1, 0.2, 0.2, 0.3, 0.4, 0.4, 0.5, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.0]
);

// Print out min/max values for validation
var minMaxLand = reclassifiedLand.reduceRegion({
  reducer: ee.Reducer.minMax(),
  geometry: filteredCountries.geometry(),
  scale: 250,
  bestEffort: true
});
var minLand = ee.Number(minMaxLand.get('remapped_min'));
var maxLand = ee.Number(minMaxLand.get('remapped_max'));
print("Min Land cover:", minLand);
print("Max Land cover:", maxLand);
Map.addLayer(reclassifiedLand, {min: 0, max: 1, palette: ['blue', 'green', 'yellow', 'red']}, "Reclassified Land Cover", false);

// Variable 4a: Drainage Density
var flowAccum = ee.Image("WWF/HydroSHEDS/15ACC").clip(filteredCountries);
var kernel = ee.Kernel.circle(5000, 'meters');
var threshold = 50;
var streamMask = flowAccum.gt(threshold);
var drainageDensity = streamMask.reduceNeighborhood({
  reducer: ee.Reducer.mean(),
  kernel: kernel
});
var minMaxDensity = drainageDensity.reduceRegion({
  reducer: ee.Reducer.minMax(),
  geometry: filteredCountries.geometry(),
  scale: 250,
  bestEffort: true
});
var minDensity = ee.Number(minMaxDensity.get('b1_mean_min'));
var maxDensity = ee.Number(minMaxDensity.get('b1_mean_max'));
print("Min Density:", minDensity);
print("Max Density:", maxDensity);
var normalizedDrainageDensity = drainageDensity.subtract(minDensity).divide(maxDensity.subtract(minDensity));
Map.addLayer(normalizedDrainageDensity, {min: 0, max: 1, palette: ['white', 'green', 'blue']}, 'Normalised Drainage Density', false);

// Variable 4b: Distance to Drainage
var streams = flowAccum.gt(threshold).selfMask();
var distanceToDrainage = streams.fastDistanceTransform().sqrt().clip(filteredCountries);
var minMax = distanceToDrainage.reduceRegion({
  reducer: ee.Reducer.minMax(),
  geometry: filteredCountries.geometry(),
  scale: 250,
  bestEffort: true
});
var minDist = ee.Number(minMax.get('distance_min'));
var maxDist = ee.Number(minMax.get('distance_max'));
print("Min Distance:", minDist);
print("Max Distance:", maxDist);
var normalizedDistance = distanceToDrainage.subtract(minDist).divide(maxDist.subtract(minDist));
normalizedDistance = ee.Image(1).subtract(normalizedDistance);
Map.addLayer(normalizedDistance, {min: 0, max: 1, palette: ["blue", "yellow", "red"]}, "Normalized Distance to Drainage", false);

// Variable 5: Soil Texture (Original)
var soilTexture = ee.Image("OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02").select("b0").clip(filteredCountries);
var reclassifiedSoil = soilTexture.remap(
 [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
 [3, 3, 3, 3, 2, 2, 2, 2, 1, 2, 1, 1]
);
reclassifiedSoil = ee.Image(4).subtract(reclassifiedSoil);
var minMaxSoilTexture = reclassifiedSoil.reduceRegion({
 reducer: ee.Reducer.minMax(),
 geometry: filteredCountries.geometry(),
 scale: 250,
 bestEffort: true
});
var minSoil = ee.Number(minMaxSoilTexture.get('constant_min'));
var maxSoil = ee.Number(minMaxSoilTexture.get('constant_max'));
print("Min Soil:", minSoil);
print("Max Soil:", maxSoil);
var normalizedSoilTexture = reclassifiedSoil.subtract(minSoil).divide(maxSoil.subtract(minSoil));
Map.addLayer(normalizedSoilTexture, {min: 0, max: 1, palette: ["yellow", "green", "red"]}, "Normalised Soil Texture", false);


// Variable 6: Soil Type (Clay %)
var soilType = ee.Image("OpenLandMap/SOL/SOL_CLAY-WFRACTION_USDA-3A1A1A_M/v02").clip(filteredCountries);
soilType = soilType.reduce(ee.Reducer.mean());
var minMaxClay = soilType.reduceRegion({
  reducer: ee.Reducer.minMax(),
  geometry: filteredCountries.geometry(),
  scale: 250,
  bestEffort: true
});
var minClay = ee.Number(minMaxClay.get('mean_min'));
var maxClay = ee.Number(minMaxClay.get('mean_max'));
print("Min Clay %:", minClay);
print("Max Clay %:", maxClay);
var normClay = soilType.subtract(minClay).divide(maxClay.subtract(minClay));
Map.addLayer(normClay.select(0), {min: 0, max: 1, palette: ["blue", "yellow", "red"]}, "Normalized Clay Percentage", false);

// Resample all layers
var targetScale = 1000;
var crs = 'EPSG:4326';
normSlope = normSlope.reproject({crs: crs, scale: targetScale});
normalizedDrainageDensity = normalizedDrainageDensity.reproject({crs: crs, scale: targetScale});
normalizedDistance = normalizedDistance.reproject({crs: crs, scale: targetScale});
normElev = normElev.reproject({crs: crs, scale: targetScale});
normClay = normClay.reproject({crs: crs, scale: targetScale});
reclassifiedLand = reclassifiedLand.reproject({crs: crs, scale: targetScale});
normalizedSoilTexture = normalizedSoilTexture.reproject({crs: crs, scale: targetScale});

// Verify ranges
print(normSlope.reduceRegion({reducer: ee.Reducer.minMax(), geometry: filteredCountries.geometry(), scale: 250, bestEffort: true}));
print(normalizedDrainageDensity.reduceRegion({reducer: ee.Reducer.minMax(), geometry: filteredCountries.geometry(), scale: 250, bestEffort: true}));
print(normalizedDistance.reduceRegion({reducer: ee.Reducer.minMax(), geometry: filteredCountries.geometry(), scale: 250, bestEffort: true}));
print(normElev.reduceRegion({reducer: ee.Reducer.minMax(), geometry: filteredCountries.geometry(), scale: 250, bestEffort: true}));
print(normClay.reduceRegion({reducer: ee.Reducer.minMax(), geometry: filteredCountries.geometry(), scale: 250, bestEffort: true}));
print(reclassifiedLand.reduceRegion({reducer: ee.Reducer.minMax(), geometry: filteredCountries.geometry(), scale: 250, bestEffort: true}));
print(normalizedSoilTexture.reduceRegion({reducer: ee.Reducer.minMax(), geometry: filteredCountries.geometry(), scale: 250, bestEffort: true}));

// Landslide Susceptibility Model
var landslideRisk = normSlope.multiply(0.3)
  .add(normalizedDrainageDensity.multiply(0.1))
  // .add(normalizedDistance.multiply(0.1)) // optional
  .add(normElev.multiply(0.1))
  .add(normClay.multiply(0.2))
  .add(reclassifiedLand.multiply(0.1))
  .add(normalizedSoilTexture.multiply(0.2));

// Rename the band to "risk"
var landslideRisk = landslideRisk.rename('risk');

var minMaxRiskLandslide = landslideRisk.reduceRegion({
  reducer: ee.Reducer.minMax(),
  geometry: filteredCountries.geometry(),
  scale: 250,
  bestEffort: true
});

var minRisk = ee.Number(minMaxRiskLandslide.get('risk_min'));
var maxRisk = ee.Number(minMaxRiskLandslide.get('risk_max'));
var normalizedLandslideRisk = landslideRisk.subtract(minRisk).divide(maxRisk.subtract(minRisk));

Map.addLayer(normalizedLandslideRisk.select(0), {
  min: 0,
  max: 1,
  palette: ['green', 'yellow', 'red']
}, "Normalized Landslide Risk");