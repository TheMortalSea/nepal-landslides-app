// ============================================================================
// Section 1: Styling and Global Variables
// ============================================================================

// Styling conventions for consistent UI appearance
var STYLES = {
    COLORS: {
      LOW_RISK: '#22c55e',    // Green for low risk
      MEDIUM_RISK: '#facc15', // Yellow for medium risk
      HIGH_RISK: '#ef4444',   // Red for high risk
      TEXT_PRIMARY: '#1f2937', // Primary text color
      TEXT_SECONDARY: '#4b5563', // Secondary text color
      TEXT_MUTED: '#6b7280',   // Muted text color
      DIVIDER: '#d1d5db',      // Divider color
      PANEL_BG: '#f3f4f6',     // Panel background color
      DISTRICT_HIGHLIGHT: '#ff00ff', // Magenta for selected district highlight
      ICON: '#808080'          // Icon color
    },
    SECTION_TITLE: {
      fontSize: '14px',
      fontWeight: 'bold',
      margin: '10px 0 5px 0',
      color: '#34495e',
      textAlign: 'center'
    },
    PANEL_TITLE: {
      fontSize: '16px',
      fontWeight: 'bold',
      margin: '0 auto',
      backgroundColor: '#f3f4f6',
      padding: '10px',
      borderRadius: '4px',
      color: '#1f2937',
      textAlign: 'center'
    },
    SUBTITLE: {
      fontSize: '12px',
      fontStyle: 'italic',
      color: '#6b7280',
      margin: '2px auto',
      textAlign: 'center'
    },
    DIVIDER: {
      height: '1px',
      backgroundColor: '#d1d5db',
      margin: '5px 0'
    }
  };
  
  // Global variables for map and UI state
  var Map = ui.Map(); // Main map for displaying data
  var currentLanguage = 'Nepali'; // Default language
  var clippedLandslideFeatures = null; // Stores pre-fetched features of clipped landslide points
  var landslidePopup = null; // Stores the popup panel for landslide details
  var currentDistrictName = null; // Tracks the currently selected district
  var loadingPanel = null; // Loading panel for displaying loading messages
  var highlightedDistrictLayer = null; // Layer for highlighting the selected district
  var isInMethodologyView = false; // Flag to track if in methodology view
  var nationalStats = {}; // Cached national statistics
  
  // ============================================================================
  // Section 2: Data Imports and Preprocessing
  // ============================================================================
  
  // Import geographical boundaries and data
  var NepalBoundary = ee.FeatureCollection("projects/ee-testing-casa-25/assets/Nepal_boundary");
  var districts = ee.FeatureCollection("projects/ee-testing-casa-25/assets/districts");
  var landslidePoints = ee.FeatureCollection("projects/ee-testing-casa-25/assets/landslides_data_v1");
  var districtFactors = ee.FeatureCollection('projects/ee-testing-casa-25/assets/NepalDistrictCalculatedFactors_V3');
  
  // Correct district name mismatches between census and boundaries layer
  var nameCorrections = ee.Dictionary({
    'CHITAWAN': 'CHITWAN',
    'KABHREPALANCHOK': 'KAVREPALANCHOK',
    'MAKAWANPUR': 'MAKWANPUR',
    'TANAHU': 'TANAHUN',
    'KAPILBASTU': 'KAPILVASTU',
    'RUKUM_E': 'RUKUM EAST',
    'RUKUM_W': 'RUKUM WEST',
    'NAWALPARASI_W': 'NAWALPARASI WEST',
    'NAWALPARASI_E': 'NAWALPARASI EAST',
    'SINDHUPALCHOK': 'SINDHUPALCHOWK',
    'TERHATHUM': 'TEHRATHUM',
    'DHANUSHA': 'DHANUSA'
  });
  
  districts = districts.map(function(feature) {
    var districtName = ee.String(feature.get('DISTRICT'));
    var correctedName = ee.Algorithms.If(
      nameCorrections.contains(districtName),
      nameCorrections.get(districtName),
      districtName
    );
    return feature.set('DISTRICT', correctedName);
  });
  
  // Load and preprocess population data (GHSL 2020) at 1 km resolution (aligned with ML code)
  var ghslPop = ee.ImageCollection('JRC/GHSL/P2023A/GHS_POP');
  var pop2020 = ghslPop.toList(12).get(9); // Year 2020 (index 9)
  var popImage = ee.Image(pop2020).select('population_count').clip(NepalBoundary);
  var populationImage = popImage
    .reduceResolution({ reducer: ee.Reducer.sum(), maxPixels: 1024 })
    .reproject({ crs: 'EPSG:4326', scale: 1000 })
    .clip(NepalBoundary);
  
  // Load precomputed landslide risk layers
  var LandslideSusceptibility = ee.Image("projects/ee-clareluikart/assets/landslide_sus");
  var RFLandslideProbability = ee.Image("projects/ee-testing-casa-25/assets/RF_Landslide_Propbability_Pop_only");
  var NormalizedLandslideRiskPop = ee.Image("projects/ee-testing-casa-25/assets/Normalized_Landslide_Risk_Pop_only");
  
  // Compute risk zones for population stats
  var thresholdZones = LandslideSusceptibility
    .where(LandslideSusceptibility.lt(0.3), 1) // Low Risk: < 0.3
    .where(LandslideSusceptibility.gte(0.3).and(LandslideSusceptibility.select('slope').lte(0.5)), 2) // Medium Risk: 0.3–0.5
    .where(LandslideSusceptibility.gt(0.5), 3) // High Risk: > 0.5
    .rename('zone')
    .updateMask(LandslideSusceptibility.mask())
    .clip(NepalBoundary);
  
  // Compute national population statistics for susceptibility model
  var populationStats = ee.Dictionary({
    popSus: ['1.0', '2.0', '3.0'].map(function(zone) {
      var maskedImage = populationImage.updateMask(thresholdZones.eq(parseFloat(zone)));
      var populationCount = maskedImage.reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: NepalBoundary.geometry(),
        scale: 1000,
        maxPixels: 1e10,
        bestEffort: true
      }).get('population_count');
      return ee.Algorithms.If(ee.Algorithms.IsEqual(populationCount, null), 0, populationCount);
    })
  });
  
  // ============================================================================
  // Section 3: Translation and Language Management
  // ============================================================================
  
  // Language translations dictionary
  var LANGUAGE_TRANSLATIONS = {
    'Nepali': {
      'Risk Scale': 'जोखिम स्तर',
      'Low < 0.3': 'कम < ०.३',
      'Medium 0.3–0.5': 'मध्यम ०.३–०.५',
      'High > 0.5': 'उच्च > ०.५',
      'National Overview': 'राष्ट्रिय अवलोकन',
      'Click on the map or select from list:': 'नक्सामा क्लिक गर्नुहोस् वा सूचीबाट चयन गर्नुहोस्:',
      'Key Risk Indicators': 'मुख्य जोखिम संकेतकहरू',
      'Susceptibility Variability (Std Dev)': 'संवेदनशीलताको परिवर्तनशीलता (मानक विचलन)',
      'Relative Risk Index (vs National Avg)': 'सापेक्ष जोखिम सूचकांक (राष्ट्रिय औसतको तुलनामा)',
      'Proportion of high-risk area based on susceptibility model is': 'संवेदनशीलता मोडेल आधारमा उच्च जोखिम क्षेत्रको अनुपात',
      'Total Population:': 'कुल जनसंख्या:',
      'people': 'जना',
      'District Risk/Impact Comparison': 'जिल्ला जोखिम/प्रभाव तुलना',
      'Historical Recorded Incidents': 'ऐतिहासिक दर्ता भएका घटनाहरू',
      'Incidents:': 'घटनाहरू:',
      'Deaths:': 'मृत्यु:',
      'Injuries:': 'घाइते:',
      'Infrastructure Destroyed:': 'पूर्वाधार नष्ट भएको:',
      'Critical Districts by Risk/Impact': 'जोखिम/प्रभाव अनुसार महत्वपूर्ण जिल्लाहरू',
      'Select a metric to rank districts by impact and click on a bar to explore the district in detail.': 'जिल्लाहरूलाई प्रभाव अनुसार क्रमबद्ध गर्न मापदण्ड चयन गर्नुहोस् र जिल्ला विस्तारमा अन्वेषण गर्न बारमा क्लिक गर्नुहोस्।',
      'Reported Incidents': 'दर्ता भएका घटनाहरू',
      'Reported Deaths': 'दर्ता भएका मृत्युहरू',
      'Reported Injuries': 'दर्ता भएका घाइतेहरू',
      'Infrastructure Impacted': 'प्रभावित पूर्वाधार',
      'View Methodology': 'विधि हेर्नुहोस्',
      'Back to District Stats': 'जिल्ला तथ्याङ्कमा फर्कनुहोस्',
      'Methodology for Landslide Susceptibility Assessment': 'भूसर्पण संवेदनशीलता मूल्यांकनको विधि',
      'Click outside Nepal boundary. Please select a point within Nepal.': 'नेपाल सीमा बाहिर क्लिक गर्नुभयो। कृपया नेपाल भित्र बिन्दु चयन गर्नुहोस्।',
      'Reset to National Overview': 'राष्ट्रिय अवलोकनमा फर्कनुहोस्',
      'Risk Distribution and Population': 'जोखिम वितरण र जनसंख्या',
      'Susceptibility Model': 'संवेदनशीलता मोडेल',
      'Population at Risk Distribution': 'जोखिममा परेको जनसंख्या वितरण',
      'Critical Districts by Risk/Impact': 'जोखिम/प्रभाव अनुसार महत्वपूर्ण जिल्लाहरू',
      'Top 5 Districts by': 'द्वारा शीर्ष ५ जिल्ला',
      'Count': 'गणना',
      'category': 'श्रेणी',
      'percentage': 'प्रतिशत',
      'district': 'जिल्ला',
      'value': 'मान',
      'Select a metric to rank districts by impact and click on a bar to explore the district in detail.': 'जिल्लाहरूलाई प्रभाव अनुसार क्रमबद्ध गर्न मापदण्ड चयन गर्नुहोस्। जिल्ला अन्वेषण गर्न बारमा क्लिक गर्नुहोस्।',
      'Methodology Overview': 'विधि अवलोकन',
      'National Avg': 'राष्ट्रिय औसत',
      'Nearby Districts': 'नजिकैका जिल्लाहरू',
      'Metric': 'मापदण्ड',
      'Incidents per km²': 'प्रति किमी² घटना',
      'Deaths per km²': 'प्रति किमी² मृत्यु',
      'Injuries per km²': 'प्रति किमी² घाइते',
      'Infrastructure Destroyed per km²': 'प्रति किमी² पूर्वाधार नष्ट',
      'Comparison with National Average and Nearest Districts:': 'राष्ट्रिय औसत र नजिकैका जिल्लाहरूसँग तुलना:',
      'Note: Nearest districts are determined by spatial proximity between districts centroids.': 'नोट: नजिकैका जिल्लाहरू जिल्लाका केन्द्रबिन्दुहरूबीचको स्थानिक नजिकताबाट निर्धारण गरिन्छ।',
      'Susceptibility': 'संवेदनशीलता',
      'Average Susceptibility': 'औसत संवेदनशीलता',
      'Susceptibility Variability': 'संवेदनशीलताको परिवर्तनशीलता',
      'Relative Risk Index': 'सापेक्ष जोखिम सूचकांक',
      'Proportion of high-risk area based on susceptibility model is': 'संवेदनशीलता मोडेल आधारमा उच्च जोखिम क्षेत्रको अनुपात',
      'Total Population': 'कुल जनसंख्या',
      'Change Language:': 'भाषा परिवर्तन गर्नुहोस्:',
      'English': 'अङ्ग्रेजी',
      'Nepali': 'नेपाली',
      'Maithili': 'मैथिली',
      'Bhojpuri': 'भोजपुरी',
      'Purpose:': 'उद्देश्य:',
      'Variables:': 'चरहरू:',
      'Output:': 'नतिजा:',
      'Method:': 'विधि:',
      'These factors are weighted based on their influence on landslides.': 'यी तत्वहरू भूस्खलनमा तिनीहरूको प्रभावको आधारमा तौल गरिएको छ।',
      'These factors are weighted based on their influence on landslides, following the methodology in Hong et al (2007).': 'यी तत्वहरू भूस्खलनमा तिनीहरूको प्रभावको आधारमा तौल गरिएको छ, हङ्ग एट अल (२००७) को विधि अनुसरण गर्दै।',
      'None': 'कुनै पनि छैन',
      'Susceptibility Thresholds': 'संवेदनशीलता सीमाहरू: कम < ०.३, मध्यम ०.३–०.५, उच्च > ०.५',
      'Susceptibility Variability Description': 'जिल्लाभरि संवेदनशीलताको भिन्नता मापन गर्दछ। कम: <०.१, मध्यम: ०.१–०.२, उच्च: >०.२',
      'Relative Risk Index Description': 'जिल्लाको जोखिमलाई राष्ट्रिय औसत (१.०) सँग तुलना गर्दछ। >१.० ले उच्च जोखिम, <१.० ले कम जोखिम जनाउँछ।',
      'Population Census Info': '२०२१ को जनगणनामा आधारित',
      'Above Avg': 'औसतभन्दा माथि',
      'Below Avg': 'औसतभन्दा तल',
      'Stage 1: Environmental Susceptibility Weighted Linear Combination Model': 'चरण १: वातावरणीय संवेदनशीलता तौलित रैखिक संयोजन मोडेल',
      'Stage 2: Random Forest Populated Area Landslide Risk Model': 'चरण २: र्यान्डम फरेस्ट जनसंख्या क्षेत्र भूस्खलन जोखिम मोडेल',
      'This app assesses landslide susceptibility and risk across Nepal using an environmental susceptibility model and a random forest classifier model.': 'यो अनुप्रयोगले नेपालभर भूस्खलन संवेदनशीलता र जोखिम मूल्यांकन गर्न वातावरणीय संवेदनशीलता मोडेल र र्यान्डम फरेस्ट वर्गीकरण मोडेल प्रयोग गर्छ।',
      'Using the Split Map Comparison': 'विभाजित नक्सा तुलना प्रयोग गर्दै',
      'The split maps enable side-by-side comparison of both models, focusing on population exposure. Drag the divider to adjust, zoom in or out, and compare them spatially.': 'विभाजित नक्साहरूले तपाईंलाई दुई भूस्खलन जोखिम मोडेलहरू सँगसँगै तुलना गर्न अनुमति दिन्छ। बायाँ नक्साले RF भूस्खलन सम्भावना (जनसंख्या भएका क्षेत्रहरूमा केन्द्रित मेसिन लर्निंग मोडेल) देखाउँछ, र दायाँ नक्साले सामान्यीकृत भूस्खलन जोखिम (जनसंख्या मात्र) (जनसंख्या जोखिमलाई समेट्ने जोखिम मोडेल) देखाउँछ। दुई मोडेलहरू स्थानिक रूपमा तुलना गर्न र दृश्य समायोजन गर्न डिभाइडर तान्नुहोस्।',
      'This model maps landslide susceptibility across Nepal using environmental variables to establish a critical baseline for understanding where risks are highest.': 'यो मोडेलले नेपालभर भूस्खलन संवेदनशीलता नक्साङ्कन गर्न वातावरणीय चरहरू प्रयोग गर्छ जसले जोखिम कहाँ उच्च छ भनेर बुझ्नको लागि एक महत्वपूर्ण आधार रेखा स्थापना गर्छ।',
      'Slope (30%), Elevation (10%), Land Cover (10%), Soil Texture (20%), Clay Content (20%), Drainage Density (10%).': 'ढलान (३०%), उचाइ (१०%), भू-आवरण (१०%), माटोको बनावट (२०%), माटोमा चिक्कन सामग्री (२०%), निकास घनत्व (१०%)।',
      'A susceptibility index map where higher values indicate greater susceptibility.': 'एक संवेदनशीलता सूचकांक नक्सा जहाँ उच्च मानले ठूलो संवेदनशीलता संकेत गर्छ।',
      'This stage builds on the environmental model by focusing specifically on populated areas. Because official landslide records often under-report incidents in uninhabited regions, restricting the model to populated areas ensures reliable training and verification.': 'यो चरणले वातावरणीय मोडेलमा आधारित भएर विशेष रूपमा जनसंख्या भएका क्षेत्रहरूमा केन्द्रित हुन्छ। किनभने आधिकारिक भूस्खलन अभिलेखहरूले प्रायः निर्जन क्षेत्रहरूमा घटनाहरू कम रिपोर्ट गर्छन्, मोडेललाई जनसंख्या भएका क्षेत्रहरूमा सीमित गर्नाले विश्वसनीय प्रशिक्षण र प्रमाणीकरण सुनिश्चित गर्छ।',
      'We mask the environmental variables to populated regions and train a Random Forest classifier using landslide incidents from 2011 and April 2025 (source: Bipad Portal) alongside randomly-generated non-landslide points within the same populated areas.': 'हामीले वातावरणीय चरहरूलाई जनसंख्या भएका क्षेत्रहरूमा मास्क गर्छौं र २०११ र अप्रिल २०२५ (स्रोत: बिपद् पोर्टल) का भूस्खलन घटनाहरू प्रयोग गरेर र्यान्डम फरेस्ट वर्गीकरणकर्तालाई प्रशिक्षण दिन्छौं साथै ती जनसंख्या भएका क्षेत्रहरूमा अनियमित रूपमा उत्पन्न गरिएका गैर-भूस्खलन बिन्दुहरूको साथमा।',
      'Probability maps (0-1) highlighting high-risk zones in populated areas, improving alignment with actual exposure and guiding local disaster preparedness.': 'संभाव्यता नक्साहरू (०-१) ले जनसंख्या भएका क्षेत्रहरूमा उच्च-जोखिम क्षेत्रहरू हाइलाइट गर्छ, वास्तविक जोखिमसँग संरेखण सुधार गर्छ र स्थानीय विपद् तयारीलाई मार्गदर्शन गर्छ।',
      'Country boundary': 'देशको सीमा',
      'District Boundaries': 'जिल्ला सीमाहरू',
      'Landslide Susceptibility': 'भूस्खलन संवेदनशीलता',
      'Landslide Incidents': 'भूस्खलन घटनाहरू',
      'RF Landslide Probability': 'आरएफ भूस्खलन सम्भावना',
      'Normalized Landslide Risk (Pop Only)': 'सामान्यीकृत भूस्खलन जोखिम (जनसंख्या मात्र)',
      'Selected District': 'चयन गरिएको जिल्ला',
      'Loading...': 'लोड हुँदैछ...',
      'Loading district data for ': 'जिल्ला डाटा लोड हुँदैछ ',
      'Risk Distribution: Unable to load population data. Showing historical incidents only.': 'जोखिम वितरण: जनसंख्या डाटा लोड गर्न सकिएन। केवल ऐतिहासिक घटनाहरू देखाइँदैछ।',
      'Nepal Landslides Risk Statistics': 'नेपाल भूस्खलन जोखिम तथ्याङ्क',
      'No district found at this location.': 'यो स्थानमा कुनै जिल्ला फेला परेन।',
      'N/A': 'उपलब्ध छैन',
      'Nepal Landslides Risk Assessment Tool': 'नेपाल भूस्खलन जोखिम मूल्यांकन उपकरण',
      'Low': 'कम',
      'Medium': 'मध्यम',
      'High': 'उच्च',
      'Select District:': 'जिल्ला चयन गर्नुहोस्:',
      'Back to Statistics': 'तथ्याङ्कमा फर्कनुहोस्',
      'RF Landslide Probability (Populated Areas)': 'आरएफ भूस्खलन सम्भावना (जनसंख्या भएका क्षेत्रहरू)',
      'Landslide Susceptibility (Populated Areas)': 'भूस्खलन संवेदनशीलता (जनसंख्या भएका क्षेत्रहरू)',
      'Click on a landslide point on the map to view incident details.': 'नक्सामा भूस्खलन बिन्दुमा क्लिक गर्नुहोस् घटना विवरण हेर्न।',
      'Landslide Events ({0} Incidents)': 'भूस्खलन घटनाहरू ({0} घटनाहरू)',
      'Missing Persons:': 'हराएका व्यक्तिहरू:',
      'More Details': 'थप विवरण',
      'Low Risk': 'कम जोखिम',
      'Medium Risk': 'मध्यम जोखिम',
      'High Risk': 'उच्च जोखिम',
      'Close': 'बन्द गर्नुहोस्'
    },
    'Maithili': {
      'Risk Scale': 'जोखिम स्तर',
      'Low < 0.3': 'कम < ०.३',
      'Medium 0.3–0.5': 'मध्यम ०.३–०.५',
      'High > 0.5': 'उच्च > ०.५',
      'Select District:': 'जिला चुनू:',
      'National Overview': 'राष्ट्रीय अवलोकन',
      'Click on the map or select from list:': 'नक्शा पर क्लिक करू या सूची सँ चुनू',
      'Key Risk Indicators': 'मुख्य जोखिम संकेतक',
      'Susceptibility Variability (Std Dev)': 'संवेदनशीलता परिवर्तनशीलता (मानक विचलन)',
      'Relative Risk Index (vs National Avg)': 'सापेक्ष जोखिम सूचकांक (राष्ट्रीय औसत सँ तुलना)',
      'Proportion of high-risk area based on susceptibility model is': 'संवेदनशीलता मॉडल आधारित उच्च जोखिम क्षेत्रक अनुपात अछि',
      'Total Population:': 'कुल जनसंख्या:',
      'people': 'लोक',
      'District Risk/Impact Comparison': 'जिला जोखिम/प्रभाव तुलना',
      'Historical Recorded Incidents': 'ऐतिहासिक दर्ज घटना',
      'Incidents:': 'घटना:',
      'Deaths:': 'मृत्यु:',
      'Injuries:': 'घायल:',
      'Infrastructure Destroyed:': 'नष्ट भेल अवसंरचना:',
      'Critical Districts by Risk/Impact': 'जोखिम/प्रभाव अनुसार महत्वपूर्ण जिला',
      'Select a metric to rank districts by impact and click on a bar to explore the district in detail.': 'जिलाक रैंकिंग करबाक लेल मापदंड चुनू। जिला एक्सप्लोर करबाक लेल बार पर क्लिक करू।',
      'Reported Incidents': 'दर्ज घटना',
      'Reported Deaths': 'दर्ज मृत्यु',
      'Reported Injuries': 'दर्ज घायल',
      'Infrastructure Impacted': 'प्रभावित अवसंरचना',
      'View Methodology': 'विधि देखू',
      'Back to District Stats': 'जिला आँकड़ामे वापस जाऊ',
      'Methodology for Landslide Susceptibility Assessment': 'भूस्खलन संवेदनशीलता मूल्यांकनक विधि',
      'Click outside Nepal boundary. Please select a point within Nepal.': 'नेपाल सीमा सँ बाहर क्लिक करल गेल। कृपया नेपाल भितर एक बिंदु चुनू।',
      'Reset to National Overview': 'राष्ट्रीय अवलोकनमे वापस जाऊ',
      'Risk Distribution and Population': 'जोखिम बितरण आ जनसंख्या',
      'Susceptibility Model': 'संवेदनशीलता मॉडल',
      'Population at Risk Distribution': 'जोखिममे जनसंख्या बितरण',
      'Critical Districts by Risk/Impact': 'जोखिम/प्रभाव अनुसार महत्वपूर्ण जिला',
      'Top 5 Districts by': 'द्वारा शीर्ष ५ जिला',
      'Count': 'गिनती',
      'category': 'श्रेणी',
      'percentage': 'प्रतिशत',
      'district': 'जिला',
      'value': 'मूल्य',
      'Select a metric to rank districts by impact and click on a bar to explore the district in detail.': 'जिलाक रैंकिंग करबाक लेल मापदंड चुनू आ जिला क विस्तारमे एक्सप्लोर करबाक लेल बार पर क्लिक करू।',
      'Methodology Overview': 'विधि अवलोकन',
      'National Avg': 'राष्ट्रीय औसत',
      'Nearby Districts': 'नजदीक जिला',
      'Metric': 'मापदंड',
      'Incidents per km²': 'प्रति किमी² घटना',
      'Deaths per km²': 'प्रति किमी² मृत्यु',
      'Injuries per km²': 'प्रति किमी² घायल',
      'Infrastructure Destroyed per km²': 'प्रति किमी² नष्ट भेल अवसंरचना',
      'Comparison with National Average and Nearest Districts:': 'राष्ट्रीय औसत आ नजदीक जिलासँग तुलना:',
      'Note: Nearest districts are determined by spatial proximity between districts centroids.': 'नोट: नजदीक जिला जिलाक केंद्रबिंदुसभक बीचक स्थानिक निकटतासँ निर्धारित कएल जाइत अछि।',
      'Susceptibility': 'संवेदनशीलता',
      'Average Susceptibility': 'औसत संवेदनशीलता',
      'Susceptibility Variability': 'संवेदनशीलताक परिवर्तनशीलता',
      'Relative Risk Index': 'सापेक्ष जोखिम सूचकांक',
      'Proportion of high-risk area based on susceptibility model is': 'संवेदनशीलता मॉडल आधारित उच्च जोखिम क्षेत्रक अनुपात',
      'Total Population': 'कुल जनसंख्या',
      'Change Language:': 'भाषा बदलू:',
      'English': 'अङ्ग्रेजी',
      'Nepali': 'नेपाली',
      'Maithili': 'मैथिली',
      'Bhojpuri': 'भोजपुरी',
      'Purpose:': 'उद्देश्य:',
      'Variables:': 'चर:',
      'Output:': 'नतिजा:',
      'Method:': 'विधि:',
      'These factors are weighted based on their influence on landslides.': 'ई तत्व भूस्खलन पर प्रभावक आधार पर तौल कएल गेल अछि।',
      'These factors are weighted based on their influence on landslides, following the methodology in Hong et al (2007).': 'ई तत्व भूस्खलन पर प्रभावक आधार पर तौल कएल गेल अछि, हङ्ग एट अल (2007) के विधि क अनुसरण करैत।',
      'None': 'कोनो नहि',
      'Susceptibility Thresholds': 'संवेदनशीलता सीमा: कम < ०.३, मध्यम ०.३–०.५, उच्च > ०.५',
      'Susceptibility Variability Description': 'जिल्लामे संवेदनशीलताक भिन्नता मापन करैत अछि। कम: <०.१, मध्यम: ०.१–०.२, उच्च: >०.२',
      'Relative Risk Index Description': 'जिल्लाक जोखिमक राष्ट्रीय औसत (१.०) सँ तुलना करैत अछि। >१.० मतलब उच्च जोखिम, <१.० मतलब कम जोखिम।',
      'Population Census Info': '२०२१ के जनगणनाक आधार पर',
      'Above Avg': 'औसतमे सँ ऊपर',
      'Below Avg': 'औसतमे सँ नीचा',
      'Stage 1: Environmental Susceptibility Weighted Linear Combination Model': 'चरण १: पर्यावरणीय संवेदनशीलता तौलित रैखिक संयोजन मॉडल',
      'Stage 2: Random Forest Populated Area Landslide Risk Model': 'चरण २: र्यान्डम फरेस्ट जनसंख्या क्षेत्र भूस्खलन जोखिम मॉडल',
      'This app assesses landslide susceptibility and risk across Nepal using an environmental susceptibility model and a random forest classifier model.': 'ई एप नेपालमे भूस्खलन संवेदनशीलता आ जोखिमक आकलन पर्यावरणीय संवेदनशीलता मॉडल आ र्यान्डम फरेस्ट वर्गीकरण मॉडल सँ करैत अछि।',
      'Using the Split Map Comparison': 'विभाजित नक्शा तुलना क उपयोग',
      'The split maps enable side-by-side comparison of both models, focusing on population exposure. Drag the divider to adjust, zoom in or out, and compare them spatially.': 'विभाजित नक्शा तपाईं क दो भूस्खलन जोखिम मॉडल क एक साथ तुलना करय देलक। बायाँ नक्शा RF भूस्खलन सम्भावना (जनसंख्या क्षेत्र पर केंद्रित एक मशीन लर्निंग मॉडल) देखबैत अछि, आ दायाँ नक्शा सामान्यीकृत भूस्खलन जोखिम (जनसंख्या मात्र) (जनसंख्या जोखिम क हिसाब राखय वाला एक जोखिम मॉडल) देखबैत अछि। दृश्य समायोजन करय आ दुई मॉडल क स्थानिक रूप सँ तुलना करय लेल डिवाइडर क खींचू।',
      'This model maps landslide susceptibility across Nepal using environmental variables to establish a critical baseline for understanding where risks are highest.': 'ई मॉडल नेपालमे भूस्खलन संवेदनशीलता क नक्शा बनबैत अछि पर्यावरणीय चर सँ जोखिम कहाँ उच्च अछि तेकर समझक लेल एक महत्वपूर्ण आधार रेखा स्थापित करैत अछि।',
      'Slope (30%), Elevation (10%), Land Cover (10%), Soil Texture (20%), Clay Content (20%), Drainage Density (10%).': 'ढलान (३०%), उचाइ (१०%), भू-आवरण (१०%), माटोक बनावट (२०%), माटोमे चिक्कन सामग्री (२०%), निकास घनत्व (१०%)।',
      'A susceptibility index map where higher values indicate greater susceptibility.': 'एक संवेदनशीलता सूचकांक नक्शा जतय उच्च मान अधिक संवेदनशीलता क संकेत दैत अछि।',
      'This stage builds on the environmental model by focusing specifically on populated areas. Because official landslide records often under-report incidents in uninhabited regions, restricting the model to populated areas ensures reliable training and verification.': 'ई चरण पर्यावरणीय मॉडल प आधारित अछि आ विशेष रूप सँ जनसंख्या क्षेत्र प ध्यान देत अछि। कियेकि आधिकारिक भूस्खलन अभिलेख प्रायः निर्जन क्षेत्रमे घटना कम दर्ज करैत अछि, मॉडल क जनसंख्या क्षेत्रमे सीमित करय सँ विश्वसनीय प्रशिक्षण आ प्रमाणीकरण सुनिश्चित होइत अछि।',
      'We mask the environmental variables to populated regions and train a Random Forest classifier using landslide incidents from 2011 and April 2025 (source: Bipad Portal) alongside randomly-generated non-landslide points within the same populated areas.': 'हम पर्यावरणीय चर क जनसंख्या क्षेत्रमे मास्क करैत छी आ २०११ आ अप्रिल २०२५ (स्रोत: बिपद् पोर्टल) क भूस्खलन घटना सँ र्यान्डम फरेस्ट वर्गीकरणकर्ता क प्रशिक्षण देत छी साथमे उहे जनसंख्या क्षेत्रमे अनियमित रूप सँ उत्पन्न गैर-भूस्खलन बिन्दु सँ।',
      'Probability maps (0-1) highlighting high-risk zones in populated areas, improving alignment with actual exposure and guiding local disaster preparedness.': 'संभाव्यता नक्शा (०-१) जनसंख्या क्षेत्रमे उच्च-जोखिम क्षेत्र क हाइलाइट करैत अछि, वास्तविक जोखिम सँ संरेखण सुधार करैत अछि आ स्थानीय विपद् तयारी क मार्गदर्शन करैत अछि।',
      'Country boundary': 'देशक सीमा',
      'District Boundaries': 'जिल्लाक सीमासभ',
      'Landslide Susceptibility': 'भूस्खलन संवेदनशीलता',
      'Landslide Incidents': 'भूस्खलन घटना',
      'RF Landslide Probability': 'आरएफ भूस्खलन सम्भावना',
      'Normalized Landslide Risk (Pop Only)': 'सामान्यीकृत भूस्खलन जोखिम (जनसंख्या मात्र)',
      'Selected District': 'चयनित जिला',
      'Loading...': 'लोड होइत अछि...',
      'Loading district data for ': 'लोड होइत अछि जिला डाटा लेल ',
      'Risk Distribution: Unable to load population data. Showing historical incidents only.': 'जोखिम बितरण: जनसंख्या डाटा लोड नहि भेल। केवल ऐतिहासिक घटनासभ देखाइत अछि।',
      'Nepal Landslides Risk Statistics': 'नेपाल भूस्खलन जोखिम आँकड़ा',
      'No district found at this location.': 'ई स्थान पर कोनो जिला नहि भेटल।',
      'N/A': 'उपलब्ध नहि',
      'Nepal Landslides Risk Assessment Tool': 'नेपाल भूस्खलन खतरा जाँच साधन',
      'Low': 'कम',
      'Medium': 'मध्यम',
      'High': 'उच्च',
      'Back to Statistics': 'आँकड़ामे वापस जाऊ',
      'RF Landslide Probability (Populated Areas)': 'आरएफ भूस्खलन सम्भावना (जनसंख्या क्षेत्र)',
      'Landslide Susceptibility (Populated Areas)': 'भूस्खलन संवेदनशीलता (जनसंख्या क्षेत्र)',
      'Click on a landslide point on the map to view incident details.': 'नक्शा पर भूस्खलन बिन्दु पर क्लिक करू घटना विवरण देखबाक लेल।',
      'Landslide Events ({0} Incidents)': 'भूस्खलन घटना ({0} घटना)',
      'Missing Persons:': 'हराएल व्यक्ति:',
      'More Details': 'आउर विवरण',
      'Low Risk': 'कम जोखिम',
      'Medium Risk': 'मध्यम जोखिम',
      'High Risk': 'उच्च जोखिम',
      'Close': 'बन्द करू'
    },
    'Bhojpuri': {
      'Risk Scale': 'जोखिम स्तर',
      'Low < 0.3': 'कम < ०.३',
      'Medium 0.3–0.5': 'मध्यम ०.३–०.५',
      'High > 0.5': 'उच्च > ०.५',
      'Select District:': 'जिला चुनीं:',
      'National Overview': 'राष्ट्रीय अवलोकन',
      'Click on the map or select from list:': 'नक्शा प क्लिक करीं या सूची से चुनीं',
      'Key Risk Indicators': 'मुख्य जोखिम संकेतक',
      'Susceptibility Variability (Std Dev)': 'संवेदनशीलता बदलाव (मानक विचलन)',
      'Relative Risk Index (vs National Avg)': 'रिलेटिव रिस्क इंडेक्स (राष्ट्रीय औसत से)',
      'Proportion of high-risk area based on susceptibility model is': 'संवेदनशीलता मॉडल के आधार प उच्च जोखिम क्षेत्र के अनुपात',
      'Total Population:': 'कुल जनसंख्या:',
      'people': 'लोग',
      'District Risk/Impact Comparison': 'जिला जोखिम/प्रभाव तुलना',
      'Historical Recorded Incidents': 'ऐतिहासिक दर्ज घटना',
      'Incidents:': 'घटना:',
      'Deaths:': 'मौत:',
      'Injuries:': 'घायल:',
      'Infrastructure Destroyed:': 'बर्बाद भइल बुनियादी ढांचा:',
      'Critical Districts by Risk/Impact': 'जोखिम/प्रभाव अनुसार महत्वपूर्ण जिला',
      'Select a metric to rank districts by impact and click on a bar to explore the district in detail.': 'जिलाक रैंकिंग करबाक लेल मापदंड चुनू आ जिला क विस्तारमे एक्सप्लोर करबाक लेल बार पर क्लिक करू।',
      'Reported Incidents': 'दर्ज घटना',
      'Reported Deaths': 'दर्ज मौत',
      'Reported Injuries': 'दर्ज घायल',
      'Infrastructure Impacted': 'प्रभावित बुनियादी ढांचा',
      'View Methodology': 'तरीका देखीं',
      'Back to District Stats': 'जिला आंकड़ा म वापस जाईं',
      'Methodology for Landslide Susceptibility Assessment': 'भूस्खलन संवेदनशीलता आकलन के तरीका',
      'Click outside Nepal boundary. Please select a point within Nepal.': 'नेपाल सीमा से बाहर क्लिक कईल गइल। कृपया नेपाल के भीतर एक बिंदु चुनीं।',
      'Reset to National Overview': 'राष्ट्रीय अवलोकन म वापस जाईं',
      'Risk Distribution and Population': 'जोखिम बाँट आ जनसंख्या',
      'Susceptibility Model': 'संवेदनशीलता मॉडल',
      'Population at Risk Distribution': 'जोखिम में जनसंख्या बाँट',
      'Critical Districts by Risk/Impact': 'जोखिम/असर अनुसार महत्वपूर्ण जिला',
      'Top 5 Districts by': 'द्वारा टॉप 5 जिला',
      'Count': 'गिनती',
      'category': 'श्रेणी',
      'percentage': 'प्रतिशत',
      'district': 'जिला',
      'value': 'मूल्य',
      'Select a metric to rank districts by impact and click on a bar to explore the district in detail.': 'जिला के रैंकिंग करे खातिर मापदंड चुनीं। जिला एक्सप्लोर करे खातिर बार प क्लिक करीं।',
      'Methodology Overview': 'विधि अवलोकन',
      'National Avg': 'राष्ट्रीय औसत',
      'Nearby Districts': 'नजदीक जिला',
      'Metric': 'मापदंड',
      'Incidents per km²': 'प्रति किमी² घटना',
      'Deaths per km²': 'प्रति किमी² मौत',
      'Injuries per km²': 'प्रति किमी² घायल',
      'Infrastructure Destroyed per km²': 'प्रति किमी² बर्बाद भइल बुनियादी ढांचा',
      'Comparison with National Average and Nearest Districts:': 'राष्ट्रीय औसत आ नजदीक जिला से तुलना:',
      'Note: Nearest districts are determined by spatial proximity between districts centroids.': 'नोट: नजदीक जिला जिला केंद्र बिंदु के बीच स्थानिक नजदीकी से तय होला।',
      'Susceptibility': 'संवेदनशीलता',
      'Average Susceptibility': 'औसत संवेदनशीलता',
      'Susceptibility Variability': 'संवेदनशीलता के बदलाव',
      'Relative Risk Index': 'रिलेटिव रिस्क इंडेक्स',
      'Proportion of high-risk area based on susceptibility model is': 'संवेदनशीलता मॉडल के आधार प उच्च जोखिम क्षेत्र के अनुपात',
      'Total Population': 'कुल जनसंख्या',
      'Change Language:': 'भाषा बदलीं:',
      'English': 'अंग्रेजी',
      'Nepali': 'नेपाली',
      'Maithili': 'मैथिली',
      'Bhojpuri': 'भोजपुरी',
      'Purpose:': 'उद्देश्य:',
      'Variables:': 'चर:',
      'Output:': 'आउटपुट:',
      'Method:': 'तरीका:',
      'These factors are weighted based on their influence on landslides.': 'ई तत्व भूस्खलन प प्रभाव के आधार प वजन दिहल गइल बा।',
      'These factors are weighted based on their influence on landslides, following the methodology in Hong et al (2007).': 'ई तत्व भूस्खलन प प्रभाव के आधार प वजन दिहल गइल बा, हङ्ग एट अल (2007) के तरीका के अनुसरण करत।',
      'None': 'कुछु नइखे',
      'Susceptibility Thresholds': 'संवेदनशीलता सीमा: कम < ०.३, मध्यम ०.३–०.५, बड़ > ०.५',
      'Susceptibility Variability Description': 'जिल्ला में संवेदनशीलता के भिन्नता के मापन करे ला। कम: <०.१, मध्यम: ०.१–०.२, बड़: >०.२',
      'Relative Risk Index Description': 'जिल्ला के जोखिम के राष्ट्रीय औसत (१.०) से तुलना करे ला। >१.० मतलब बड़ जोखिम, <१.० मतलब कम जोखिम।',
      'Population Census Info': '२०२१ के जनगणना प आधारित',
      'Above Avg': 'औसत से बड़',
      'Below Avg': 'औसत से कम',
      'Stage 1: Environmental Susceptibility Weighted Linear Combination Model': 'चरण १: पर्यावरणीय संवेदनशीलता तौलित रैखिक संयोजन मॉडल',
      'Stage 2: Random Forest Populated Area Landslide Risk Model': 'चरण २: र्यान्डम फरेस्ट जनसंख्या क्षेत्र भूस्खलन जोखिम मॉडल',
      'This app assesses landslide susceptibility and risk across Nepal using an environmental susceptibility model and a random forest classifier model.': 'ई एप नेपालमे भूस्खलन संवेदनशीलता आ जोखिमक आकलन पर्यावरणीय संवेदनशीलता मॉडल आ र्यान्डम फरेस्ट वर्गीकरण मॉडल सँ करत बा।',
      'Using the Split Map Comparison': 'विभाजित नक्शा तुलना क उपयोग',
      'The split maps enable side-by-side comparison of both models, focusing on population exposure. Drag the divider to adjust, zoom in or out, and compare them spatially.': 'विभाजित नक्शा तपाईं क दो भूस्खलन जोखिम मॉडल क एक साथ तुलना करय देलक। बायाँ नक्शा RF भूस्खलन सम्भावना (जनसंख्या क्षेत्र पर केंद्रित एक मशीन लर्निंग मॉडल) देखबैत अछि, आ दायाँ नक्शा सामान्यीकृत भूस्खलन जोखिम (जनसंख्या मात्र) (जनसंख्या जोखिम क हिसाब राखय वाला एक जोखिम मॉडल) देखबैत अछि। दृश्य समायोजन करय आ दुई मॉडल क स्थानिक रूप सँ तुलना करय लेल डिवाइडर क खींचू।',
      'This model maps landslide susceptibility across Nepal using environmental variables to establish a critical baseline for understanding where risks are highest.': 'ई मॉडल नेपालमे भूस्खलन संवेदनशीलता क नक्शा बनावत बा पर्यावरणीय चर सँ जोखिम कहाँ बड़ बा तेकर समझक लेल एक महत्वपूर्ण आधार रेखा स्थापित करत बा।',
      'Slope (30%), Elevation (10%), Land Cover (10%), Soil Texture (20%), Clay Content (20%), Drainage Density (10%).': 'ढलान (३०%), उचाइ (१०%), भू-आवरण (१०%), माटोक बनावट (२०%), माटोमे चिक्कन सामग्री (२०%), निकास घनत्व (१०%)।',
      'A susceptibility index map where higher values indicate greater susceptibility.': 'एक संवेदनशीलता सूचकांक नक्शा जतय बड़ मान बड़ संवेदनशीलता क संकेत देत बा।',
      'This stage builds on the environmental model by focusing specifically on populated areas. Because official landslide records often under-report incidents in uninhabited regions, restricting the model to populated areas ensures reliable training and verification.': 'ई चरण पर्यावरणीय मॉडल प आधारित बा आ विशेष रूप सँ जनसंख्या क्षेत्र प ध्यान देत बा। कियेकि आधिकारिक भूस्खलन अभिलेख प्रायः निर्जन क्षेत्रमे घटना कम दर्ज करत बा, मॉडल क जनसंख्या क्षेत्रमे सीमित करय सँ विश्वसनीय प्रशिक्षण आ प्रमाणीकरण सुनिश्चित होइत बा।',
      'We mask the environmental variables to populated regions and train a Random Forest classifier using landslide incidents from 2011 and April 2025 (source: Bipad Portal) alongside randomly-generated non-landslide points within the same populated areas.': 'हम पर्यावरणीय चर क जनसंख्या क्षेत्रमे मास्क करत बानी आ २०११ आ अप्रिल २०२५ (स्रोत: बिपद् पोर्टल) क भूस्खलन घटना सँ र्यान्डम फरेस्ट वर्गीकरणकर्ता क प्रशिक्षण देत बानी साथमे उहे जनसंख्या क्षेत्रमे अनियमित रूप सँ उत्पन्न गैर-भूस्खलन बिन्दु सँ।',
      'Probability maps (0-1) highlighting high-risk zones in populated areas, improving alignment with actual exposure and guiding local disaster preparedness.': 'संभाव्यता नक्शा (०-१) जनसंख्या क्षेत्रमे उच्च-जोखिम क्षेत्र क हाइलाइट करत बा, वास्तविक जोखिम सँ संरेखण सुधार करत बा आ स्थानीय विपद् तयारी क मार्गदर्शन करत बा।',
      'Country boundary': 'देशक सीमा',
      'District Boundaries': 'जिल्लाक सीमासभ',
      'Landslide Susceptibility': 'भूस्खलन संवेदनशीलता',
      'Landslide Incidents': 'भूस्खलन घटना',
      'RF Landslide Probability': 'आरएफ भूस्खलन सम्भावना',
      'Normalized Landslide Risk (Pop Only)': 'सामान्यीकृत भूस्खलन जोखिम (जनसंख्या मात्र)',
      'Selected District': 'चयनित जिला',
      'Loading...': 'लोड होइत बा...',
      'Loading district data for ': 'लोड होइत बा जिला डाटा खातिर ',
      'Risk Distribution: Unable to load population data. Showing historical incidents only.': 'जोखिम बाँट: जनसंख्या डाटा लोड नहि भइल। केवल ऐतिहासिक घटनासभ देखावल जा रहल बा।',
      'Nepal Landslides Risk Statistics': 'नेपाल भूस्खलन जोखिम आँकड़ा',
      'No district found at this location.': 'ई स्थान पर कोनो जिला नहि भेटल।',
      'N/A': 'उपलब्ध नहि',
      'Nepal Landslides Risk Assessment Tool': 'नेपाल भूस्खलन जोखिम आकलन उपकरण',
      'Low': 'कम',
      'Medium': 'मध्यम',
      'High': 'उच्च',
      'Back to Statistics': 'आँकड़ा म वापस जाईं',
      'RF Landslide Probability (Populated Areas)': 'आरएफ भूस्खलन सम्भावना (जनसंख्या क्षेत्र)',
      'Landslide Susceptibility (Populated Areas)': 'भूस्खलन संवेदनशीलता (जनसंख्या क्षेत्र)',
      'Click on a landslide point on the map to view incident details.': 'नक्शा प भूस्खलन बिन्दु प क्लिक करीं घटना के विवरण देखीं।',
      'Landslide Events ({0} Incidents)': 'भूस्खलन घटना ({0} घटना)',
      'Missing Persons:': 'गायब लोग:',
      'More Details': 'आउर ब्यौरा',
      'Low Risk': 'कम जोखिम',
      'Medium Risk': 'मध्यम जोखिम',
      'High Risk': 'बड़ जोखिम',
      'Close': 'बन्द करीं'
    },
    'English': {
      'Risk Scale': 'Risk Scale',
      'Low < 0.3': 'Low < 0.3',
      'Medium 0.3–0.5': 'Medium 0.3–0.5',
      'High > 0.5': 'High > 0.5',
      'Select District:': 'Select District:',
      'National Overview': 'National Overview',
      'Click on the map or select from list:': 'Click on the map or select from list:',
      'Key Risk Indicators': 'Key Risk Indicators',
      'Susceptibility Variability (Std Dev)': 'Susceptibility Variability (Std Dev)',
      'Relative Risk Index (vs National Avg)': 'Relative Risk Index (vs National Avg)',
      'Proportion of high-risk area based on susceptibility model is': 'Proportion of high-risk area based on susceptibility model is',
      'Total Population:': 'Total Population:',
      'people': 'people',
      'District Risk/Impact Comparison': 'District Risk/Impact Comparison',
      'Historical Recorded Incidents': 'Historical Recorded Incidents',
      'Incidents:': 'Incidents:',
      'Deaths:': 'Deaths:',
      'Injuries:': 'Injuries:',
      'Infrastructure Destroyed:': 'Infrastructure Destroyed:',
      'Critical Districts by Risk/Impact': 'Critical Districts by Risk/Impact',
      'Select a metric to rank districts by impact and click on a bar to explore the district in detail.': 'Select a metric to rank districts by impact and click on a bar to explore the district in detail.',
      'Reported Incidents': 'Reported Incidents',
      'Reported Deaths': 'Reported Deaths',
      'Reported Injuries': 'Reported Injuries',
      'Infrastructure Impacted': 'Infrastructure Impacted',
      'View Methodology': 'View Methodology',
      'Back to District Stats': 'Back to District Stats',
      'Methodology for Landslide Susceptibility Assessment': 'Methodology for Landslide Susceptibility Assessment',
      'Click outside Nepal boundary. Please select a point within Nepal.': 'Click outside Nepal boundary. Please select a point within Nepal.',
      'Reset to National Overview': 'Reset to National Overview',
      'Risk Distribution and Population': 'Risk Distribution and Population',
      'Susceptibility Model': 'Susceptibility Model',
      'Population at Risk Distribution': 'Population at Risk Distribution',
      'Critical Districts by Risk/Impact': 'Critical Districts by Risk/Impact',
      'Top 5 Districts by': 'Top 5 Districts by',
      'Count': 'Count',
      'category': 'category',
      'percentage': 'percentage',
      'district': 'district',
      'value': 'value',
      'Select a metric to rank districts by impact and click on a bar to explore the district in detail.': 'Select a metric to rank districts by impact and click on a bar to explore the district in detail.',
      'Methodology Overview': 'Methodology Overview',
      'National Avg': 'National Average',
      'Nearby Districts': 'Nearby Districts',
      'Metric': 'Metric',
      'Incidents per km²': 'Incidents per km²',
      'Deaths per km²': 'Deaths per km²',
      'Injuries per km²': 'Injuries per km²',
      'Infrastructure Destroyed per km²': 'Infrastructure Destroyed per km²',
      'Comparison with National Average and Nearest Districts:': 'Comparison with National Average and Nearest Districts:',
      'Note: Nearest districts are determined by spatial proximity between districts centroids.': 'Note: Nearest districts are determined by spatial proximity between districts centroids.',
      'Susceptibility': 'Susceptibility',
      'Average Susceptibility': 'Average Susceptibility',
      'Susceptibility Variability': 'Susceptibility Variability',
      'Relative Risk Index': 'Relative Risk Index',
      'Proportion of high-risk area based on susceptibility model is': 'Proportion of high-risk area based on susceptibility model is',
      'Total Population': 'Total Population',
      'Change Language:': 'Change Language:',
      'English': 'English',
      'Nepali': 'Nepali',
      'Maithili': 'Maithili',
      'Bhojpuri': 'Bhojpuri',
      'Purpose:': 'Purpose:',
      'Variables:': 'Variables:',
      'Output:': 'Output:',
      'Method:': 'Method:',
      'These factors are weighted based on their influence on landslides.': 'These factors are weighted based on their influence on landslides.',
      'These factors are weighted based on their influence on landslides, following the methodology in Hong et al (2007).': 'These factors are weighted based on their influence on landslides, following the methodology in Hong et al (2007).',
      'None': 'None',
      'Susceptibility Thresholds': 'Low < 0.3, Medium 0.3–0.5, High > 0.5',
      'Susceptibility Variability Description': 'Measures variation in susceptibility across the district. Low: <0.1, Medium: 0.1–0.2, High: >0.2',
      'Relative Risk Index Description': 'Compares district risk to the national average (1.0). >1.0 means higher risk, <1.0 means lower risk.',
      'Population Census Info': 'Based on 2021 census',
      'Above Avg': 'Above Avg',
      'Below Avg': 'Below Avg',
      'Stage 1: Environmental Susceptibility Weighted Linear Combination Model': 'Stage 1: Environmental Susceptibility Weighted Linear Combination Model',
      'Stage 2: Random Forest Populated Area Landslide Risk Model': 'Stage 2: Random Forest Populated Area Landslide Risk Model',
      'This app assesses landslide susceptibility and risk across Nepal using an environmental susceptibility model and a random forest classifier model.': 'This app assesses landslide susceptibility and risk across Nepal using an environmental susceptibility model and a random forest classifier model.',
      'Using the Split Map Comparison': 'Using the Split Map Comparison',
      'The split maps enable side-by-side comparison of both models, focusing on population exposure. Drag the divider to adjust, zoom in or out, and compare them spatially.': 'The split maps enable side-by-side comparison of both models, focusing on population exposure. Drag the divider to adjust, zoom in or out, and compare them spatially.',
      'This model maps landslide susceptibility across Nepal using environmental variables to establish a critical baseline for understanding where risks are highest.': 'This model maps landslide susceptibility across Nepal using environmental variables to establish a critical baseline for understanding where risks are highest.',
      'Slope (30%), Elevation (10%), Land Cover (10%), Soil Texture (20%), Clay Content (20%), Drainage Density (10%).': 'Slope (30%), Elevation (10%), Land Cover (10%), Soil Texture (20%), Clay Content (20%), Drainage Density (10%).',
      'A susceptibility index map where higher values indicate greater susceptibility.': 'A susceptibility index map where higher values indicate greater susceptibility.',
      'This stage builds on the environmental model by focusing specifically on populated areas. Because official landslide records often under-report incidents in uninhabited regions, restricting the model to populated areas ensures reliable training and verification.': 'This stage builds on the environmental model by focusing specifically on populated areas. Because official landslide records often under-report incidents in uninhabited regions, restricting the model to populated areas ensures reliable training and verification.',
      'We mask the environmental variables to populated regions and train a Random Forest classifier using landslide incidents from 2011 and April 2025 (source: Bipad Portal) alongside randomly-generated non-landslide points within the same populated areas.': 'We mask the environmental variables to populated regions and train a Random Forest classifier using landslide incidents from 2011 and April 2025 (source: Bipad Portal) alongside randomly-generated non-landslide points within the same populated areas.',
      'Probability maps (0-1) highlighting high-risk zones in populated areas, improving alignment with actual exposure and guiding local disaster preparedness.': 'Probability maps (0-1) highlighting high-risk zones in populated areas, improving alignment with actual exposure and guiding local disaster preparedness.',
      'Country boundary': 'Country boundary',
      'District Boundaries': 'District Boundaries',
      'Landslide Susceptibility': 'Landslide Susceptibility',
      'Landslide Incidents': 'Landslide Incidents',
      'RF Landslide Probability': 'RF Landslide Probability',
      'Normalized Landslide Risk (Pop Only)': 'Normalized Landslide Risk (Pop Only)',
      'Selected District': 'Selected District',
      'Loading...': 'Loading...',
      'Loading district data for ': 'Loading district data for ',
      'Risk Distribution: Unable to load population data. Showing historical incidents only.': 'Risk Distribution: Unable to load population data. Showing historical incidents only.',
      'Nepal Landslides Risk Statistics': 'Nepal Landslides Risk Statistics',
      'No district found at this location.': 'No district found at this location.',
      'N/A': 'N/A',
      'Nepal Landslides Risk Assessment Tool': 'Nepal Landslides Risk Assessment Tool',
      'Low': 'Low',
      'Medium': 'Medium',
      'High': 'High',
      'Back to Statistics': 'Back to Statistics',
      'RF Landslide Probability (Populated Areas)': 'RF Landslide Probability (Populated Areas)',
      'Landslide Susceptibility (Populated Areas)': 'Landslide Susceptibility (Populated Areas)',
      'Click on a landslide point on the map to view incident details.': 'Click on a landslide point on the map to view incident details.',
      'Landslide Events ({0} Incidents)': 'Landslide Events ({0} Incidents)',
      'Missing Persons:': 'Missing Persons:',
      'More Details': 'More Details',
      'Low Risk': 'Low Risk',
      'Medium Risk': 'Medium Risk',
      'High Risk': 'High Risk',
      'Close': 'Close'
    }
  };
  
  // Translates text based on the current language
  function translate(text) {
    if (!LANGUAGE_TRANSLATIONS[currentLanguage]) {
      return text; // Fallback to English if language not supported
    }
    return LANGUAGE_TRANSLATIONS[currentLanguage][text] || text;
  }
  
  // Defines risk levels for the legend, updated with the current language
  function getRiskLevels() {
    return [
      { label: translate('Low < 0.3'), color: STYLES.COLORS.LOW_RISK },
      { label: translate('Medium 0.3–0.5'), color: STYLES.COLORS.MEDIUM_RISK },
      { label: translate('High > 0.5'), color: STYLES.COLORS.HIGH_RISK }
    ];
  }
  
  // Updates the language across the UI and resets to national view
  function updateLanguage(lang) {
    currentLanguage = lang;
  
    // Update layer names on the main map
    if (susceptibilityLayer) susceptibilityLayer.setName(translate('Landslide Susceptibility'));
    if (probabilityLayer) probabilityLayer.setName(translate('RF Landslide Probability (Populated Areas)'));
    if (normalizedRiskLayer) normalizedRiskLayer.setName(translate('Landslide Susceptibility (Populated Areas)'));
    if (countryBoundaryLayer) countryBoundaryLayer.setName(translate('Country boundary'));
    if (districtBoundariesLayer) districtBoundariesLayer.setName(translate('District Boundaries'));
    if (landslidePointsLayer) landslidePointsLayer.setName(translate('Landslide Incidents'));
    
    Map.layers().forEach(function(layer) {
      var untranslatedName = layer.untranslatedName;
      if (untranslatedName) {
        layer.setName(translate(untranslatedName));
      }
    });
  
    if (isInMethodologyView) {
      var leftLayerVisibility = {};
      leftMap.layers().forEach(function(layer) {
        var untranslatedName = layer.untranslatedName;
        if (untranslatedName) {
          leftLayerVisibility[untranslatedName] = layer.getShown();
        }
      });
  
      var rightLayerVisibility = {};
      rightMap.layers().forEach(function(layer) {
        var untranslatedName = layer.untranslatedName;
        if (untranslatedName) {
          rightLayerVisibility[untranslatedName] = layer.getShown();
        }
      });
  
      leftMap.layers().reset();
      leftMap.layers().add(leftCountryBoundaryLayer);
      leftMap.layers().add(leftDistrictBoundariesLayer);
      leftMap.layers().add(leftProbabilityLayer);
  
      rightMap.layers().reset();
      rightMap.layers().add(rightCountryBoundaryLayer);
      rightMap.layers().add(rightDistrictBoundariesLayer);
      rightMap.layers().add(rightNormalizedRiskLayer);
      
      // Update layer names for leftMap
    leftCountryBoundaryLayer.setName(translate('Country boundary'));
    leftDistrictBoundariesLayer.setName(translate('District Boundaries'));
    leftProbabilityLayer.setName(translate('RF Landslide Probability (Populated Areas)'));
  
    // Update layer names for rightMap
    rightCountryBoundaryLayer.setName(translate('Country boundary'));
    rightDistrictBoundariesLayer.setName(translate('District Boundaries'));
    rightNormalizedRiskLayer.setName(translate('Landslide Susceptibility (Populated Areas)'));
  
      if (leftLayerVisibility['Country boundary']) leftCountryBoundaryLayer.setShown(leftLayerVisibility['Country boundary']);
      if (leftLayerVisibility['District Boundaries']) leftDistrictBoundariesLayer.setShown(leftLayerVisibility['District Boundaries']);
      if (leftLayerVisibility['RF Landslide Probability (Populated Areas)']) leftProbabilityLayer.setShown(leftLayerVisibility['RF Landslide Probability (Populated Areas)']);
      if (rightLayerVisibility['Country boundary']) rightCountryBoundaryLayer.setShown(rightLayerVisibility['Country boundary']);
      if (rightLayerVisibility['District Boundaries']) rightDistrictBoundariesLayer.setShown(rightLayerVisibility['District Boundaries']);
      if (rightLayerVisibility['Landslide Susceptibility (Populated Areas)']) rightNormalizedRiskLayer.setShown(rightLayerVisibility['Landslide Susceptibility (Populated Areas)']);
  
      leftMapTitle.setValue(translate('RF Landslide Probability (Populated Areas)'));
      rightMapTitle.setValue(translate('Landslide Susceptibility (Populated Areas)'));
    }
  
    appTitleLabel.setValue(translate('Nepal Landslides Risk Assessment Tool'));
  
    if (landslidePopup) {
      var aggregatedData = landslidePopup.aggregatedData || {};
      var clickCoords = { lon: landslidePopup.clickLon, lat: landslidePopup.clickLat };
      if (Object.keys(aggregatedData).length > 0 && clickCoords && aggregatedData.incidentCount > 0) {
        showLandslidePopup(aggregatedData, clickCoords);
      } else {
        hideLandslidePopup();
      }
    }
  
    updateLegend();
  
    if (!isInMethodologyView) {
      initializeDistrictSelect();
      if (districtInstructionLabel) {
        districtInstructionLabel.setValue(translate('Click on the map or select from list:'));
      }
  
      var widgets = controlPanel.widgets();
      var instructionIndex = widgets.indexOf(districtInstructionLabel);
      var selectIndex = widgets.indexOf(districtSelectPanel);
  
      if (instructionIndex !== 2) {
        if (instructionIndex !== -1) widgets.remove(districtInstructionLabel);
        widgets.insert(2, districtInstructionLabel);
      }
      if (selectIndex !== 3) {
        if (selectIndex !== -1) widgets.remove(districtSelectPanel);
        widgets.insert(3, districtSelectPanel);
      }
  
      districtSelect.setValue('National Overview');
      showFullSummary();
    } else {
      StatisticsPanel.clear();
      var methodologyContent = createMethodologyContent('national', null);
      StatisticsPanel.add(methodologyContent);
      StatisticsPanel.style().set({
        shown: true,
        width: '500px',
        padding: '10px',
        backgroundColor: '#ffffff',
        borderRadius: '8px',
        position: 'top-right'
      });
      controlPanel.style().set({
        shown: true,
        maxWidth: '500px'
      });
  
      // Create a panel to hold both buttons side by side
      var buttonPanel = ui.Panel({
        layout: ui.Panel.Layout.flow('horizontal'),
        style: {
          margin: '14px auto',
          stretch: 'horizontal',
          textAlign: 'center',
          //gap: '10px'
        }
      });
  
      // Add the "Back to Statistics" button with adjusted width
      buttonPanel.add(ui.Button({
        label: translate('Back to Statistics'),
        onClick: function() {
          resetToNationalView();
        },
        style: { 
          backgroundColor: '#007bff', 
          width: '145px', // Reduced width to fit two buttons
          textAlign: 'center'
        }
      }));
  
      // Add the "More Details" button linking to the external URL
      buttonPanel.add(ui.Button({
        label: translate('More Details'),
        onClick: function() {
          window.open('https://maheer-maps.github.io/CASA25_Rasternauts/', '_blank');
        },
        style: { 
          backgroundColor: '#28a745', // Green color to differentiate
          width: '145px', // Matching width
          textAlign: 'center'
        }
      }));
  
      StatisticsPanel.add(buttonPanel);
    }
  }
  // ============================================================================
  // Section 4: Map Setup and Layer Management
  // ============================================================================
  
  // Define map layers with consistent color palette
  var susceptibilityLayer = ui.Map.Layer(LandslideSusceptibility, {min: 0, max: 1, palette: [STYLES.COLORS.LOW_RISK, STYLES.COLORS.MEDIUM_RISK, STYLES.COLORS.HIGH_RISK]}, translate('Landslide Susceptibility'), true);
  susceptibilityLayer.untranslatedName = 'Landslide Susceptibility';
  var probabilityLayer = ui.Map.Layer(RFLandslideProbability, {min: 0, max: 1, palette: [STYLES.COLORS.LOW_RISK, STYLES.COLORS.MEDIUM_RISK, STYLES.COLORS.HIGH_RISK]}, translate('RF Landslide Probability (Populated Areas)'), false);
  probabilityLayer.untranslatedName = 'RF Landslide Probability (Populated Areas)';
  var normalizedRiskLayer = ui.Map.Layer(NormalizedLandslideRiskPop, {min: 0, max: 1, palette: [STYLES.COLORS.LOW_RISK, STYLES.COLORS.MEDIUM_RISK, STYLES.COLORS.HIGH_RISK]}, translate('Landslide Susceptibility (Populated Areas)'), false);
  normalizedRiskLayer.untranslatedName = 'Landslide Susceptibility (Populated Areas)';
  var countryBoundaryLayer = ui.Map.Layer(NepalBoundary, {color: 'black', width: 5, fillColor: '#00000000'}, translate('Country boundary'), true);
  countryBoundaryLayer.untranslatedName = 'Country boundary';
  var dis_boundary = {color: '#787876', width: 1, fillColor: '#00000000'};
  var districtBoundariesLayer = ui.Map.Layer(districts.style(dis_boundary), {}, translate('District Boundaries'), true);
  districtBoundariesLayer.untranslatedName = 'District Boundaries';
  var landslidePointsLayer = ui.Map.Layer(landslidePoints, {pointSize: 0.25, color: '#7B3F00'}, translate('Landslide Incidents'), false);
  landslidePointsLayer.untranslatedName = 'Landslide Incidents';
  
  // Set up the main map with initial layers
  Map.centerObject(LandslideSusceptibility, 7);
  Map.layers().reset();
  Map.layers().add(countryBoundaryLayer);
  Map.layers().add(susceptibilityLayer);
  Map.layers().add(districtBoundariesLayer);
  Map.layers().add(landslidePointsLayer);
  
  // Customize basemap road display
  var roadNetwork = [
    {stylers: [{saturation: -100}]},
    {featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{color: '#000055'}, {weight: 0.1}]},
    {featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{color: '#000000'}, {weight: 0.1}]},
    {featureType: 'road.arterial', elementType: 'geometry', stylers: [{color: '#FF0000'}, {weight: 0.1}]},
    {featureType: 'road.local', elementType: 'geometry', stylers: [{color: '#00FF55'}, {weight: 0.1}]}
  ];
  Map.setOptions('roadNetwork', { roadNetwork: roadNetwork });
  
  // Updates the legend with the current language
  var legendPanel;
  function updateLegend() {
    var riskLevels = getRiskLevels();
    // Remove existing legend panel from both Map and rightMap to prevent duplication
    if (legendPanel) {
      Map.remove(legendPanel);
      rightMap.remove(legendPanel);
    }
    legendPanel = ui.Panel({
      widgets: [
        ui.Label(translate('Risk Scale'), { 
          fontSize: '14px', 
          fontWeight: 'bold', 
          color: STYLES.COLORS.TEXT_PRIMARY, 
          margin: '5px auto',
          backgroundColor: '#00000000'
        }),
        ui.Label('🟢 ' + riskLevels[0].label, { 
          fontSize: '12px', 
          color: STYLES.COLORS.TEXT_SECONDARY,
          backgroundColor: '#00000000',
          margin: '2px 5px'
        }),
        ui.Label('🟡 ' + riskLevels[1].label, { 
          fontSize: '12px', 
          color: STYLES.COLORS.TEXT_SECONDARY,
          backgroundColor: '#00000000',
          margin: '2px 5px'
        }),
        ui.Label('🔴 ' + riskLevels[2].label, { 
          fontSize: '12px', 
          color: STYLES.COLORS.TEXT_SECONDARY,
          backgroundColor: '#00000000',
          margin: '2px 5px' 
        })
      ],
      style: {
        position: 'bottom-right',
        backgroundColor: 'rgba(255, 255, 255, 0.8)',
        padding: '8px',
        borderRadius: '5px',
        margin: '10px'
      }
    });
    // Add legendPanel based on current view
    if (isInMethodologyView) {
      rightMap.add(legendPanel);
    } else {
      Map.add(legendPanel);
    }
  }
  updateLegend();
  
  // Clears map layers except for essential boundaries and selected district
  function clearMapLayersExceptHighlight() {
    var layers = Map.layers();
    for (var i = layers.length() - 1; i >= 0; i--) {
      var layer = layers.get(i);
      var name = layer.getName();
      if (name !== translate('Selected District') && name !== translate('Country boundary') && name !== translate('District Boundaries')) {
        Map.layers().remove(layer);
      }
    }
  }
  
  // Highlights a selected district on the map
  function highlightDistrict(district) {
    if (highlightedDistrictLayer) {
      Map.layers().remove(highlightedDistrictLayer);
      highlightedDistrictLayer = null;
    }
    var districtFC = ee.FeatureCollection([district]);
    var highlightStyle = {color: '#000000', width: 5, fillColor: '#00000000'};
    highlightedDistrictLayer = ui.Map.Layer(districtFC.style(highlightStyle), {}, translate('Selected District'), true);
    highlightedDistrictLayer.untranslatedName = 'Selected District';
    Map.layers().add(highlightedDistrictLayer);
    
    var districtGeometry = district.geometry().simplify({maxError: 100});
    var clippedLandslide = landslidePoints.filterBounds(districtGeometry);
    var clippedSus = LandslideSusceptibility.clip(districtGeometry);
  
    clippedLandslideFeatures = null;
    clippedLandslide.evaluate(function(features) {
      clippedLandslideFeatures = features.features || [];
    });
  
    clearMapLayersExceptHighlight();
  
    var susceptibilityLayerclip = ui.Map.Layer(clippedSus, {min: 0, max: 1, palette: [STYLES.COLORS.LOW_RISK, STYLES.COLORS.MEDIUM_RISK, STYLES.COLORS.HIGH_RISK]}, translate('Landslide Susceptibility'), true);
    var clippedLandslideLayer = ui.Map.Layer(clippedLandslide, {pointSize: 0.25, color: '#7B3F00'}, translate('Landslide Incidents'), true);
    clippedLandslideLayer.untranslatedName = 'Landslide Incidents';
    
    Map.layers().add(susceptibilityLayerclip);
    Map.layers().add(clippedLandslideLayer);
    
    Map.centerObject(district, 9);
  }
  
  // Clears the highlighted district layer
  function clearHighlightedDistrict() {
    if (highlightedDistrictLayer) {
      Map.layers().remove(highlightedDistrictLayer);
      highlightedDistrictLayer = null;
    }
  }
  
  // ============================================================================
  // Section 5: Split Map Setup for Methodology View
  // ============================================================================
  
  // Define maps for the split panel (slider comparison)
  var leftMap = ui.Map();
  var rightMap = ui.Map();
  
  // Add country boundary layers to split maps
  var leftCountryBoundaryLayer = ui.Map.Layer(NepalBoundary, {color: 'black', width: 5, fillColor: '#00000000'}, translate('Country boundary'));
  leftCountryBoundaryLayer.untranslatedName = 'Country boundary';
  leftMap.layers().add(leftCountryBoundaryLayer);
  var rightCountryBoundaryLayer = ui.Map.Layer(NepalBoundary, {color: 'black', width: 5, fillColor: '#00000000'}, translate('Country boundary'));
  rightCountryBoundaryLayer.untranslatedName = 'Country boundary';
  rightMap.layers().add(rightCountryBoundaryLayer);
  
  // Add district boundary layers to split maps
  var dis_boundary = {color: '#787876', width: 1, fillColor: '#00000000'};
  var leftDistrictBoundariesLayer = ui.Map.Layer(districts.style(dis_boundary), {}, translate('District Boundaries'));
  leftDistrictBoundariesLayer.untranslatedName = 'District Boundaries';
  leftMap.layers().add(leftDistrictBoundariesLayer);
  var rightDistrictBoundariesLayer = ui.Map.Layer(districts.style(dis_boundary), {}, translate('District Boundaries'));
  rightDistrictBoundariesLayer.untranslatedName = 'District Boundaries';
  rightMap.layers().add(rightDistrictBoundariesLayer);
  
  // Add risk layers to split maps
  var leftProbabilityLayer = ui.Map.Layer(probabilityLayer.getEeObject(), probabilityLayer.getVisParams(), translate('RF Landslide Probability (Populated Areas)'));
  leftProbabilityLayer.untranslatedName = 'RF Landslide Probability (Populated Areas)';
  leftMap.layers().add(leftProbabilityLayer);
  var rightNormalizedRiskLayer = ui.Map.Layer(normalizedRiskLayer.getEeObject(), normalizedRiskLayer.getVisParams(), translate('Landslide Susceptibility (Populated Areas)'));
  rightNormalizedRiskLayer.untranslatedName = 'Landslide Susceptibility (Populated Areas)';
  rightMap.layers().add(rightNormalizedRiskLayer);
  
  // Create title labels for each map
  var leftMapTitle = ui.Label({
    value: translate('RF Landslide Probability (Populated Areas)'),
    style: {
      position: 'top-left',
      fontSize: '14px',
      fontWeight: 'bold',
      color: STYLES.COLORS.TEXT_PRIMARY,
      backgroundColor: 'rgba(255, 255, 255, 0.8)',
      padding: '5px',
      borderRadius: '5px',
      margin: '5px'
    }
  });
  var rightMapTitle = ui.Label({
    value: translate('Landslide Susceptibility (Populated Areas)'),
    style: {
      position: 'top-right',
      fontSize: '14px',
      fontWeight: 'bold',
      color: STYLES.COLORS.TEXT_PRIMARY,
      backgroundColor: 'rgba(255, 255, 255, 0.8)',
      padding: '5px',
      borderRadius: '5px',
      margin: '5px'
    }
  });
  
  // Add titles to the maps
  leftMap.add(leftMapTitle);
  rightMap.add(rightMapTitle);
  
  // Center both maps on the same area as the main map
  leftMap.centerObject(LandslideSusceptibility, 7);
  rightMap.centerObject(LandslideSusceptibility, 7);
  
  // Link the maps so they zoom and pan together
  var mapLinker = ui.Map.Linker([leftMap, rightMap]);
  
  // Create the split panel with wipe enabled for slider-like comparison
  var splitPanel = ui.SplitPanel({
    firstPanel: leftMap,
    secondPanel: rightMap,
    orientation: 'horizontal',
    wipe: true,
    style: { stretch: 'both' }
  });
  
  // ============================================================================
  // Section 6: UI Components and Panels
  // ============================================================================
  
  // Creates the StatisticsPanel for displaying risk stats
  var StatisticsPanel = ui.Panel({
    style: {
      width: '500px',
      padding: '10px',
      backgroundColor: '#ffffff',
      borderRadius: '8px',
      fontSize: '14px',
      margin: '15px 0',
      position: 'top-right'
    }
  });
  
  // Creates the control panel for the UI header (top-right)
  var appTitleLabel = ui.Label(translate("Nepal Landslides Risk Assessment Tool"), {
    fontSize: '25px',
    fontWeight: 'bold',
    margin: '5px auto',
    padding: '10px',
    borderRadius: '4px',
    color: '#1f2937',
    textAlign: 'right'
  });
  
  var controlPanel = ui.Panel({
    widgets: [
      appTitleLabel,
      ui.Panel({ style: STYLES.DIVIDER })
    ],
    style: { maxWidth: "500px" },
    layout: ui.Panel.Layout.flow("vertical", true)
  });
  
  // District selection dropdown
  var districtNamesList = districts.aggregate_array('DISTRICT').map(function(name) {
    return ee.String(name).toUpperCase();
  }).sort();
  
  var districtSelect;
  var districtInstructionLabel = ui.Label(translate('Click on the map or select from list:'), { fontSize: '12px', margin: '5px auto', textAlign: 'center' });
  var districtSelectPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {
      margin: '5px auto',
      padding: '8px',
      backgroundColor: 'rgba(240, 240, 240, 0.9)',
      border: '1px solid #d1d5db',
      borderRadius: '5px',
      textAlign: 'center'
    }
  });
  
  // Initializes the district select dropdown with translated labels
  function initializeDistrictSelect() {
    var districtSelectItems = [
      { label: translate('National Overview'), value: 'National Overview' }
    ].concat(districtNamesList.getInfo().map(function(name) {
      return { label: capitalizeFirstLetter(name), value: name };
    }));
    
    districtSelect = ui.Select({
      items: districtSelectItems,
      placeholder: translate('Select District:'),
      value: 'National Overview',
      style: { margin: '5px', width: '200px' },
      onChange: function(value) {
        if (value === 'National Overview') {
          resetToNationalView();
        } else {
          selectDistrict(value);
        }
      }
    });
    
    districtSelectPanel.clear();
    districtSelectPanel.add(ui.Label(translate('Select District:'), { fontSize: '14px', fontWeight: 'bold', backgroundColor: '#00000000', margin: '10px auto' }));
    districtSelectPanel.add(districtSelect);
  }
  
  // Language selection dropdown
  var languageSelect = ui.Select({
    items: [
      {label: 'English', value: 'English'},
      {label: 'Nepali', value: 'Nepali'},
      {label: 'Maithili', value: 'Maithili'}, 
      {label: 'Bhojpuri', value: 'Bhojpuri'}
    ],
    value: currentLanguage,
    style: { margin: '5px', width: '100px' },
      onChange: function(value) {
        if (!isInMethodologyView) {
          resetToNationalView();
        }
        updateLanguage(value);
      }
    });
  
  var languagePanel = ui.Panel({
    widgets: [
      ui.Label('🌐', { 
        fontSize: '16px', 
        margin: '5px 5px 0 0',
        color: 'black',
        backgroundColor: '#00000000'
      }),
      ui.Label('Change Language:', { 
        fontSize: '12px', 
        margin: '12px auto',
        color: STYLES.COLORS.TEXT_PRIMARY,
        backgroundColor: '#00000000'
      }),
      languageSelect
    ],
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {
      position: 'bottom-left', 
      backgroundColor: 'rgba(255, 255, 255, 0.8)',
      padding: '8px',
      borderRadius: '5px',
      margin: '10px' 
    }
  });
  
  // ============================================================================
  // Section 7: Loading and Popup Management
  // ============================================================================
  
  // Shows a loading message on the map
  function showLoadingMessage(message) {
    hideLoadingMessage();
    loadingPanel = ui.Panel({
      widgets: [
        ui.Label(message, {
          fontSize: '14px',
          fontWeight: 'bold',
          color: STYLES.COLORS.TEXT_PRIMARY,
          backgroundColor: 'rgba(255, 255, 255, 0.9)',
          padding: '10px',
          borderRadius: '5px',
          textAlign: 'center'
        })
      ],
      style: {
        position: 'top-center', 
        margin: '350px 0 0 0' 
      }
    });
    Map.add(loadingPanel);
  }
  
  // Hides the loading message
  function hideLoadingMessage() {
    if (loadingPanel) {
      Map.remove(loadingPanel);
      loadingPanel = null;
    }
  }
  
  // Shows a popup with aggregated landslide data
  function showLandslidePopup(aggregatedData, coords) {
    hideLandslidePopup();
    var incidentCount = aggregatedData.incidentCount || 0;
    var totalDeaths = aggregatedData.totalDeaths || 0;
    var totalInjuries = aggregatedData.totalInjuries || 0;
    var totalMissing = aggregatedData.totalMissing || 0;
    var totalInfraDestroyed = aggregatedData.totalInfraDestroyed || 0;
  
    if (incidentCount === 0) {
      return;
    }
  
    var contentPanel = ui.Panel({
      layout: ui.Panel.Layout.flow('vertical'),
      style: {
        margin: '0',
        padding: '0',
        backgroundColor: '#ffffff'
      }
    });
  
    var titleTemplate = translate('Landslide Events ({0} Incidents)');
    var title = titleTemplate.replace('{0}', incidentCount);
    contentPanel.add(ui.Label(title, {
      fontSize: '16px',
      fontWeight: 'bold',
      color: STYLES.COLORS.TEXT_PRIMARY,
      margin: '5px 0',
      backgroundColor: '#ffffff',
      textAlign: 'center'
    }));
  
    contentPanel.add(ui.Panel({
      style: {
        height: '1px',
        backgroundColor: '#d1d5db',
        margin: '5px 0'
      }
    }));
  
    function createRow(labelKey, value) {
      return ui.Panel({
        widgets: [
          ui.Label(translate(labelKey), {
            fontSize: '13px',
            fontWeight: 'bold',
            color: STYLES.COLORS.TEXT_PRIMARY,
            margin: '2px 8px 2px 0',
            width: '120px',
            backgroundColor: '#ffffff'
          }),
          ui.Panel({
            style: {
              width: '1px',
              backgroundColor: '#d1d5db',
              margin: '2px 8px 2px 0'
            }
          }),
          ui.Label(String(value), {
            fontSize: '12px',
            color: STYLES.COLORS.TEXT_SECONDARY,
            margin: '2px 0',
            backgroundColor: '#ffffff'
          })
        ],
        layout: ui.Panel.Layout.flow('horizontal'),
        style: {
          margin: '2px 0',
          padding: '2px 0',
          backgroundColor: '#ffffff'
        }
      });
    }
  
    contentPanel.add(createRow('Deaths:', totalDeaths));
    contentPanel.add(createRow('Injuries:', totalInjuries));
    contentPanel.add(createRow('Missing Persons:', totalMissing));
    contentPanel.add(createRow('Infrastructure Destroyed:', totalInfraDestroyed));
  
    var closeButton = ui.Button({
      label: translate('Close'),
      onClick: function() {
        hideLandslidePopup();
      },
      style: {
        margin: '5px auto',
        stretch: 'horizontal',
        textAlign: 'center',
        backgroundColor: '#00000000',
        color: '#007bff',
        padding: '4px',
        borderRadius: '4px',
        border: 'none'
      }
    });
  
    landslidePopup = ui.Panel({
      widgets: [
        contentPanel,
        closeButton
      ],
      layout: ui.Panel.Layout.flow('vertical'),
      style: {
        position: 'bottom-center',
        margin: '10px',
        backgroundColor: '#ffffff',
        padding: '5px',
        borderRadius: '8px',
        border: '1px solid #d1d5db',
        width: '220px'
      }
    });
  
    landslidePopup.clickLon = coords.lon;
    landslidePopup.clickLat = coords.lat;
    landslidePopup.aggregatedData = aggregatedData;
    Map.add(landslidePopup);
  }
  
  // Hides the landslide popup
  function hideLandslidePopup() {
    if (landslidePopup) {
      Map.remove(landslidePopup);
      landslidePopup = null;
    }
  }
  
  // ============================================================================
  // Section 8: Helper Functions for UI Elements
  // ============================================================================
  
  // Helper function to capitalize the first letter of each word
  function capitalizeFirstLetter(str) {
    return str.toLowerCase().replace(/(^|\s)\w/g, function(letter) {
      return letter.toUpperCase();
    });
  }
  
  // Creates a divider panel
  function createDividerPanel() {
    return ui.Panel({ style: STYLES.DIVIDER });
  }
  
  // Creates a centered horizontal panel with labels
  function createCenteredPanel(labels, extraStyle) {
    return ui.Panel({
      widgets: labels.map(function(label) {
        var style = { fontSize: '12px', color: STYLES.COLORS.TEXT_SECONDARY, margin: '5px auto', textAlign: 'center' };
        if (extraStyle && extraStyle.fontSize) style.fontSize = extraStyle.fontSize;
        if (extraStyle && extraStyle.fontWeight) style.fontWeight = extraStyle.fontWeight;
        if (typeof label !== 'string' && typeof label !== 'number') {
          if (label.style && label.style.fontWeight) style.fontWeight = label.style.fontWeight;
          if (label.style && label.style.color) style.color = label.style.color;
          label = label.text;
        }
        return ui.Label(String(label || 0), style);
      }),
      layout: ui.Panel.Layout.flow('horizontal', true),
      style: { margin: '2px 0', stretch: 'horizontal', textAlign: 'center' }
    });
  }
  
  // Creates the historical incidents section
  function createHistoricalIncidentsSection(incidentCount, deaths, injuries, infraDestroyed) {
    var displayIncidentCount = incidentCount === 0 ? translate('None') : incidentCount;
    var displayDeaths = deaths === 0 ? translate('None') : deaths;
    var displayInjuries = injuries === 0 ? translate('None') : injuries;
    var displayInfraDestroyed = infraDestroyed === 0 ? translate('None') : infraDestroyed;
  
    return ui.Panel({
      widgets: [
        createDividerPanel(),
        ui.Label(translate('Historical Recorded Incidents'), STYLES.SECTION_TITLE),
        ui.Panel({
          widgets: [
            createCenteredPanel([
              { text: translate('Incidents:'), style: { fontWeight: 'bold' } },
              displayIncidentCount,
              { text: translate('Deaths:'), style: { fontWeight: 'bold' } },
              displayDeaths
            ], { fontSize: '14px' }),
            createCenteredPanel([
              { text: translate('Injuries:'), style: { fontWeight: 'bold' } },
              displayInjuries,
              { text: translate('Infrastructure Destroyed:'), style: { fontWeight: 'bold' } },
              displayInfraDestroyed
            ], { fontSize: '14px' })
          ],
          layout: ui.Panel.Layout.flow('vertical'),
          style: { margin: '2px 0', stretch: 'horizontal', textAlign: 'center' }
        })
      ],
      layout: ui.Panel.Layout.flow('vertical')
    });
  }
  
  // Creates the methodology content panel for the methodology view
  function createMethodologyContent(viewType, districtName) {
    var contentPanel = ui.Panel({
      layout: ui.Panel.Layout.flow('vertical'),
      style: {
        padding: '15px',
        backgroundColor: STYLES.COLORS.PANEL_BG, 
        border: '1px solid ' + STYLES.COLORS.TEXT_MUTED, 
        borderRadius: '8px', 
        width: '450px',
        margin: '2px auto'
      }
    });
  
    // Introduction
    contentPanel.add(ui.Label(translate('Methodology Overview'), {
      fontSize: '16px', width:'400px', fontWeight: 'bold',
      margin: '10px auto', color: STYLES.COLORS.TEXT_PRIMARY, 
      textAlign: 'center', padding: '8px',
      borderRadius: '4px'
    }));
    contentPanel.add(ui.Label(
      translate('This app assesses landslide susceptibility and risk across Nepal using an environmental susceptibility model and a random forest classifier model.'),
      { fontSize: '12px', margin: '5px 0 10px 0', textAlign: 'center', padding: '0 10px', backgroundColor: '#00000000'}
    ));
   
    // Divider
    contentPanel.add(createDividerPanel());
  
    // Stage 1: Landslide Susceptibility Model
    contentPanel.add(ui.Label(translate('Stage 1: Environmental Susceptibility Weighted Linear Combination Model'), {
      fontSize: '16px',
      width: '400px',
      fontWeight: 'bold',
      margin: '15px auto',  
      color: STYLES.COLORS.TEXT_PRIMARY,
      textAlign: 'center',
      backgroundColor: '#e5e7eb',
      padding: '8px 25px',
      borderRadius: '4px'
    }));
    contentPanel.add(ui.Panel({
      widgets: [
        ui.Label(translate('Purpose:'), {
          fontSize: '12px', 
          margin: '5px 0 0 10px', 
          padding: '2px', 
          fontWeight: 'bold', 
          color: STYLES.COLORS.TEXT_PRIMARY, 
          backgroundColor: '#00000000'
        }),
        ui.Label(
          translate('This model maps landslide susceptibility across Nepal using environmental variables to establish a critical baseline for understanding where risks are highest.'),
          { 
            fontSize: '12px', 
            margin: '0 0 5px 10px', 
            padding: '5px', 
            textAlign: 'left', 
            backgroundColor: '#00000000',
            color: STYLES.COLORS.TEXT_PRIMARY
          }
        )
      ],
      layout: ui.Panel.Layout.flow('vertical'),
      style: { margin: '0', padding: '0' }
    }));
    contentPanel.add(ui.Panel({
      widgets: [
        ui.Label(translate('Variables:'), {
          fontSize: '12px', 
          margin: '5px 0 0 10px', 
          padding: '2px', 
          fontWeight: 'bold', 
          color: STYLES.COLORS.TEXT_PRIMARY,
          backgroundColor: '#00000000'
        }),
        ui.Label(
          translate('Slope (30%), Elevation (10%), Land Cover (10%), Soil Texture (20%), Clay Content (20%), Drainage Density (10%).') + ' ' + translate('These factors are weighted based on their influence on landslides, following the methodology in Hong et al (2007).'),
          { 
            fontSize: '12px', 
            margin: '0 0 5px 10px', 
            padding: '5px', 
            textAlign: 'left', 
            backgroundColor: '#00000000',
            color: STYLES.COLORS.TEXT_PRIMARY
          }
        )
      ],
      layout: ui.Panel.Layout.flow('vertical'),
      style: { margin: '0', padding: '0' }
    }));
    contentPanel.add(ui.Panel({
      widgets: [
        ui.Label(translate('Output:'), {
          fontSize: '12px', 
          fontWeight: 'bold', 
          color: STYLES.COLORS.TEXT_PRIMARY, 
          margin: '5px 0 0 10px', 
          padding: '2px', 
          backgroundColor: '#00000000'
        }),
        ui.Label(
          translate('A susceptibility index map where higher values indicate greater susceptibility.'),
          { 
            fontSize: '12px', 
            margin: '0 0 5px 10px',
            padding: '5px', 
            textAlign: 'left', 
            backgroundColor: '#00000000',
            color: STYLES.COLORS.TEXT_PRIMARY
          }
        )
      ],
      layout: ui.Panel.Layout.flow('vertical'),
      style: { margin: '0', padding: '0' }
    }));
  
    // Divider
    contentPanel.add(createDividerPanel());
  
    // Stage 2: Random Forest Populated Area Landslide Risk Model
    contentPanel.add(ui.Label(translate('Stage 2: Random Forest Populated Area Landslide Risk Model'), {
      fontSize: '16px', fontWeight: 'bold',
      width: '400px', margin: '15px auto', 
      color: STYLES.COLORS.TEXT_PRIMARY, textAlign: 'center',
      backgroundColor: '#e5e7eb', padding: '8px 25px', borderRadius: '4px'
    }));
    contentPanel.add(ui.Panel({
      widgets: [
        ui.Label(translate('Purpose:'), {
          fontSize: '12px', fontWeight: 'bold', color: STYLES.COLORS.TEXT_PRIMARY, 
          margin: '5px 0 0 10px', padding: '2px', backgroundColor: '#00000000'
        }),
        ui.Label(
          translate('This stage builds on the environmental model by focusing specifically on populated areas. Because official landslide records often under-report incidents in uninhabited regions, restricting the model to populated areas ensures reliable training and verification.'),
          { 
            fontSize: '12px', margin: '0 0 5px 10px', 
            padding: '5px', textAlign: 'left', 
            backgroundColor: '#00000000', color: STYLES.COLORS.TEXT_PRIMARY
          }
        )
      ],
      layout: ui.Panel.Layout.flow('vertical'),
      style: { margin: '0', padding: '0' }
    }));
    contentPanel.add(ui.Panel({
      widgets: [
        ui.Label(translate('Method:'), {
          fontSize: '12px', fontWeight: 'bold', 
          color: STYLES.COLORS.TEXT_PRIMARY, margin: '5px 0 0 10px', padding: '2px', backgroundColor: '#00000000'
        }),
        ui.Label(
          translate('We mask the environmental variables to populated regions and train a Random Forest classifier using landslide incidents from 2011 and April 2025 (source: Bipad Portal) alongside randomly-generated non-landslide points within the same populated areas.'),
          { 
            fontSize: '12px', 
            margin: '0 0 5px 10px', 
            padding: '5px', 
            textAlign: 'left', 
            backgroundColor: '#00000000',
            color: STYLES.COLORS.TEXT_PRIMARY
          }
        )
      ],
      layout: ui.Panel.Layout.flow('vertical'),
      style: { margin: '0', padding: '0' }
    }));
    contentPanel.add(ui.Panel({
      widgets: [
        ui.Label(translate('Output:'), {
          fontSize: '12px', 
          fontWeight: 'bold', color: STYLES.COLORS.TEXT_PRIMARY, 
          margin: '5px 0 0 10px', padding: '2px', backgroundColor: '#00000000'
        }),
        ui.Label(
          translate('Probability maps (0-1) highlighting high-risk zones in populated areas, improving alignment with actual exposure and guiding local disaster preparedness.'),
          { 
            fontSize: '12px', 
            margin: '0 0 5px 10px',
            padding: '5px', 
            textAlign: 'left', 
            backgroundColor: '#00000000',
            color: STYLES.COLORS.TEXT_PRIMARY
          }
        )
      ],
      layout: ui.Panel.Layout.flow('vertical'),
      style: { margin: '0', padding: '0' }
    }));
  
    // Split Map Instructions
    contentPanel.add(createDividerPanel());
    contentPanel.add(ui.Label(translate('Using the Split Map Comparison'), {
      fontSize: '16px', fontWeight: 'bold', width: '400px',
      margin: '15px auto', 
      color: STYLES.COLORS.TEXT_PRIMARY, textAlign: 'center',
      backgroundColor: '#e5e7eb', padding: '8px 25px', borderRadius: '4px'
    }));
    contentPanel.add(ui.Label(
      translate('The split maps enable side-by-side comparison of both models, focusing on population exposure. Drag the divider to adjust, zoom in or out, and compare them spatially.'),
      { 
        fontSize: '12px', 
        color: STYLES.COLORS.TEXT_SECONDARY, 
        margin: '5px 0 10px 0', 
        textAlign: 'center', 
        padding: '0 10px', 
        backgroundColor: '#00000000'
      }
    ));
    return contentPanel;
  }
  
  // ============================================================================
  // Section 9: Core Functionality
  // ============================================================================
  
  // Resets the app to the national view
  function resetToNationalView() {
    isInMethodologyView = false;
    
    if (ui.root.widgets().get(1) === splitPanel) {
      rightMap.remove(legendPanel);
      leftMap.remove(languagePanel);
      leftMap.layers().reset();
      rightMap.layers().reset();
      ui.root.widgets().set(1, Map);
      Map.add(languagePanel);
    }
    
    clearHighlightedDistrict();
    hideLandslidePopup();
    clippedLandslideFeatures = null;
    currentDistrictName = null;
    
    Map.layers().reset();
    Map.layers().add(countryBoundaryLayer);
    Map.layers().add(susceptibilityLayer);
    Map.layers().add(districtBoundariesLayer);
    Map.layers().add(landslidePointsLayer);
    
    var widgets = controlPanel.widgets();
    var instructionIndex = widgets.indexOf(districtInstructionLabel);
    var selectIndex = widgets.indexOf(districtSelectPanel);
  
    if (instructionIndex !== 2) {
      if (instructionIndex !== -1) widgets.remove(districtInstructionLabel);
      widgets.insert(2, districtInstructionLabel);
      districtInstructionLabel.setValue(translate('Click on the map or select from list:'));
    }
    if (selectIndex !== 3) {
      if (selectIndex !== -1) widgets.remove(districtSelectPanel);
      widgets.insert(3, districtSelectPanel);
    }
    
    initializeDistrictSelect();
    districtSelect.setValue('National Overview');
    
    StatisticsPanel.clear();
    
    if (controlPanel.widgets().indexOf(StatisticsPanel) === -1) {
      controlPanel.widgets().add(StatisticsPanel);
    }
    
    Map.centerObject(NepalBoundary, 7);
  
    // Ensure the legend is added back to the main Map
    updateLegend();
    
    showFullSummary(true);
    
    controlPanel.style().set({
      shown: true,
      maxWidth: '500px',
      position: 'top-right'
    });
    
    StatisticsPanel.style().set({
      shown: true,
      width: '500px',
      padding: '10px',
      backgroundColor: '#ffffff',
      borderRadius: '8px',
      position: 'top-right',
      margin: '15px 0'
    });
  }
  // Selects a district and displays its stats
  function selectDistrict(districtName) {
    hideLandslidePopup();
    districtName = districtName.trim().toUpperCase();
    currentDistrictName = districtName;
  
    StatisticsPanel.clear();
    StatisticsPanel.add(ui.Label(translate('Loading district data for ') + capitalizeFirstLetter(districtName) + '...', STYLES.SUBTITLE));
    showLoadingMessage(translate('Loading district data for ') + capitalizeFirstLetter(districtName) + '...');
  
    // Ensure district selection widgets are present in controlPanel
    var widgets = controlPanel.widgets();
    var instructionIndex = widgets.indexOf(districtInstructionLabel);
    var selectIndex = widgets.indexOf(districtSelectPanel);
  
    if (instructionIndex !== 2) {
      if (instructionIndex !== -1) widgets.remove(districtInstructionLabel);
      widgets.insert(2, districtInstructionLabel);
    }
    if (selectIndex !== 3) {
      if (selectIndex !== -1) widgets.remove(districtSelectPanel);
      widgets.insert(3, districtSelectPanel);
    }
  
    var selectedDistrict = districts.filter(ee.Filter.eq('DISTRICT', districtName)).first();
    if (!selectedDistrict) {
      StatisticsPanel.widgets().set(0, ui.Label(translate('District not found in districts dataset: ') + districtName, STYLES.SUBTITLE));
      StatisticsPanel.add(ui.Label(translate('This district may be missing from the districts dataset. Please try another district.'), { fontSize: '12px', color: STYLES.COLORS.TEXT_MUTED, textAlign: 'center' }));
      StatisticsPanel.add(ui.Button({
        label: translate('Reset to National Overview'),
        onClick: function() {
          resetToNationalView();
        },
        style: { margin: '10px auto', stretch: 'horizontal', textAlign: 'center' }
      }));
      hideLoadingMessage();
      return;
    }
  
    highlightDistrict(selectedDistrict);
    var districtData = districtFactors.filter(ee.Filter.eq('DISTRICT', districtName)).first();
  
    if (!districtData) {
      StatisticsPanel.widgets().set(0, ui.Label(translate('District data not found in districtFactors: ') + districtName, STYLES.SUBTITLE));
      StatisticsPanel.add(ui.Label(translate('This district may be missing from the precomputed data. Please try another district.'), { fontSize: '12px', color: STYLES.COLORS.TEXT_MUTED, textAlign: 'center' }));
      StatisticsPanel.add(ui.Button({
        label: translate('Reset to National Overview'),
        onClick: function() {
          resetToNationalView();
        },
        style: { margin: '10px auto', stretch: 'horizontal', textAlign: 'center' }
      }));
      hideLoadingMessage();
      return;
    }
  
    districtData.evaluate(function(values) {
      if (!values) {
        StatisticsPanel.widgets().set(0, ui.Label(translate('Failed to retrieve data for district: ') + districtName, STYLES.SUBTITLE));
        StatisticsPanel.add(ui.Label(translate('This district may be missing from the precomputed data or there was a server error.'), { fontSize: '12px', color: STYLES.COLORS.TEXT_MUTED, textAlign: 'center' }));
        StatisticsPanel.add(ui.Button({
          label: translate('Reset to National Overview'),
          onClick: function() {
            resetToNationalView();
          },
          style: { margin: '10px auto', stretch: 'horizontal', textAlign: 'center' }
        }));
        hideLoadingMessage();
        return;
      }
  
      var props = values.properties || {};
      var highRiskPercentage = Number(props.highRiskPercentage) || 0;
      var totalPopulation = Number(props.totalPopulation) || 0;
      var incidentCountValue = Number(props.incidentCount) || 0;
      var deathsValue = Number(props.deaths) || 0;
      var injuriesValue = Number(props.injuries) || 0;
      var infraDestroyedValue = Number(props.infraDestroyed) || 0;
      var avgSusceptibility = Number(props.avgSusceptibility) || 0;
      var susceptibilityStdDev = Number(props.susceptibilityStdDev) || 0;
      var relativeRiskIndex = Number(props.relativeRiskIndex) || 0;
      var incidentsPerKm2 = Number(props.incidentsPerKm2) || 0;
      var deathsPerKm2 = Number(props.deathsPerKm2) || 0;
      var injuriesPerKm2 = Number(props.injuriesPerKm2) || 0;
      var infraDestroyedPerKm2 = Number(props.infraDestroyedPerKm2) || 0;
      var neighbor1Name = props.neighbor1 || '';
      var neighbor2Name = props.neighbor2 || '';
      var areaKm2 = Number(props.area_km2) || 0;
  
      highRiskPercentage = highRiskPercentage.toFixed(1);
      totalPopulation = Math.round(totalPopulation);
      avgSusceptibility = avgSusceptibility.toFixed(2);
      susceptibilityStdDev = susceptibilityStdDev.toFixed(2);
      relativeRiskIndex = relativeRiskIndex.toFixed(2);
      incidentsPerKm2 = incidentsPerKm2.toFixed(4);
      deathsPerKm2 = deathsPerKm2.toFixed(4);
      injuriesPerKm2 = injuriesPerKm2.toFixed(4);
      infraDestroyedPerKm2 = infraDestroyedPerKm2.toFixed(4);
  
      var variabilityLevel = susceptibilityStdDev < 0.1 ? translate('Low') : (susceptibilityStdDev <= 0.2 ? translate('Medium') : translate('High'));
      var variabilityColor = variabilityLevel === translate('Low') ? STYLES.COLORS.LOW_RISK : (variabilityLevel === translate('Medium') ? STYLES.COLORS.MEDIUM_RISK : STYLES.COLORS.HIGH_RISK);
  
      var neighbor1Data = neighbor1Name ? districtFactors.filter(ee.Filter.eq('DISTRICT', neighbor1Name.toUpperCase())).first() : null;
      var neighbor2Data = neighbor2Name ? districtFactors.filter(ee.Filter.eq('DISTRICT', neighbor2Name.toUpperCase())).first() : null;
  
      ee.Dictionary({
        neighbor1: neighbor1Data ? neighbor1Data : null,
        neighbor2: neighbor2Data ? neighbor2Data : null
      }).evaluate(function(evalValues) {
        if (!evalValues) {
          StatisticsPanel.clear();
          StatisticsPanel.add(ui.Label(translate('Failed to retrieve neighbor data for district: ') + districtName, STYLES.SUBTITLE));
          StatisticsPanel.add(ui.Label(translate('There may be a server error or missing data for neighbors.'), { fontSize: '12px', color: STYLES.COLORS.TEXT_MUTED, textAlign: 'center' }));
          StatisticsPanel.add(ui.Button({
            label: translate('Reset to National Overview'),
            onClick: function() {
              resetToNationalView();
            },
            style: { margin: '10px auto', stretch: 'horizontal', textAlign: 'center' }
          }));
          hideLoadingMessage();
          return;
        }
  
        var neighbor1Props = evalValues.neighbor1 ? evalValues.neighbor1.properties : {};
        var neighbor2Props = evalValues.neighbor2 ? evalValues.neighbor2.properties : {};
  
        var neighbor1Metrics = {
          incidentsPerKm2: Number(neighbor1Props.incidentsPerKm2) || 0,
          deathsPerKm2: Number(neighbor1Props.deathsPerKm2) || 0,
          injuriesPerKm2: Number(neighbor1Props.injuriesPerKm2) || 0,
          infraDestroyedPerKm2: Number(neighbor1Props.infraDestroyedPerKm2) || 0
        };
        var neighbor2Metrics = {
          incidentsPerKm2: Number(neighbor2Props.incidentsPerKm2) || 0,
          deathsPerKm2: Number(neighbor2Props.deathsPerKm2) || 0,
          injuriesPerKm2: Number(neighbor2Props.injuriesPerKm2) || 0,
          infraDestroyedPerKm2: Number(neighbor2Props.infraDestroyedPerKm2) || 0
        };
  
        StatisticsPanel.clear();
        StatisticsPanel.add(ui.Label(translate('Click on a landslide point on the map to view incident details.'), {
          fontSize: '13px',
          fontStyle: 'italic',
          color: STYLES.COLORS.TEXT_SECONDARY,
          margin: '5px auto',
          textAlign: 'center'
        }));
  
        StatisticsPanel.add(createDividerPanel());
        StatisticsPanel.add(ui.Label(translate('Key Risk Indicators'), STYLES.SECTION_TITLE));
  
        var indicatorsGrid = ui.Panel({
          layout: ui.Panel.Layout.flow('horizontal', true),
          style: { 
            stretch: 'horizontal', 
            margin: '0 auto',
            padding: '0 5px'
          }
        });
  
        function createIndicatorCard(label, valueText, bracketText, descriptionText) {
          var valuePanel = ui.Panel({
            widgets: [
              ui.Label(valueText, { 
                fontSize: '16px', 
                fontWeight: 'bold', 
                margin: '2px auto',
                backgroundColor: '#00000000',
                color: STYLES.COLORS.TEXT_SECONDARY,
              }),
              ui.Label(bracketText, { 
                fontSize: '12px',
                margin: '3px',
                backgroundColor: '#00000000',
                color: STYLES.COLORS.TEXT_SECONDARY
              })
            ],
            layout: ui.Panel.Layout.flow('horizontal'),
            style: { 
              margin: '2px auto',
              textAlign: 'center',
              stretch: 'horizontal',
              backgroundColor: '#00000000'
            }
          });
  
          var descriptionLabel = ui.Label(translate(descriptionText), { 
            fontSize: '10px', 
            color: STYLES.COLORS.TEXT_MUTED, 
            margin: '2px auto',
            backgroundColor: '#00000000',
            textAlign: 'center'
          });
  
          var separator = ui.Panel({
            style: {
              height: '1px',
              backgroundColor: '#d1d5db',
              margin: '5px 0'
            }
          });
  
          return ui.Panel({
            widgets: [
              ui.Label(label, { 
                fontSize: '14px', 
                fontWeight: 'bold', 
                margin: '5px auto',
                backgroundColor: '#00000000',
                textAlign: 'center',
                height: '40px'
              }),
              separator,
              valuePanel,
              descriptionLabel
            ],
            layout: ui.Panel.Layout.flow('vertical'),
            style: {
              backgroundColor: '#f3f4f6',
              border: '1px solid #d1d5db',
              padding: '8px',
              margin: '5px auto',
              width: '200px',
              textAlign: 'center'
            }
          });
        }
  
        var susceptibilityText = avgSusceptibility;
        var susceptibilityBracket = ' (' + (avgSusceptibility < 0.3 ? translate('Low') : (avgSusceptibility <= 0.5 ? translate('Medium') : translate('High'))) + ')';
        var susceptibilityCard = createIndicatorCard(
          translate('Average Susceptibility'),
          susceptibilityText,
          susceptibilityBracket,
          '' 
        );
  
        var variabilityText = susceptibilityStdDev;
        var variabilityBracket = ' (' + translate(variabilityLevel) + ')';
        var variabilityCard = createIndicatorCard(
          translate('Susceptibility Variability (Std Dev)'),
          variabilityText,
          variabilityBracket,
          'Susceptibility Variability Description'
        );
  
        var riskIndexText = relativeRiskIndex;
        var riskIndexBracket = ' (' + translate(relativeRiskIndex > 1.0 ? 'Above Avg' : 'Below Avg') + ')';
        var riskIndexCard = createIndicatorCard(
          translate('Relative Risk Index (vs National Avg)'),
          riskIndexText,
          riskIndexBracket,
          'Relative Risk Index Description'
        );
  
        var populationCard = createIndicatorCard(
          translate('Total Population'),
          totalPopulation.toLocaleString(),
          translate('people'),
          'Population Census Info'
        );
  
        indicatorsGrid.add(susceptibilityCard);
        indicatorsGrid.add(variabilityCard);
        indicatorsGrid.add(riskIndexCard);
        indicatorsGrid.add(populationCard);
        StatisticsPanel.add(indicatorsGrid);
  
        StatisticsPanel.add(createDividerPanel());
        StatisticsPanel.add(ui.Label(translate('District Risk/Impact Comparison'), STYLES.SECTION_TITLE));
  
        var metrics = ['incidentsPerKm2', 'deathsPerKm2', 'injuriesPerKm2', 'infraDestroyedPerKm2'];
        var metricLabels = {
          'incidentsPerKm2': translate('Incidents per km²'),
          'deathsPerKm2': translate('Deaths per km²'),
          'injuriesPerKm2': translate('Injuries per km²'),
          'infraDestroyedPerKm2': translate('Infrastructure Destroyed per km²')
        };
  
        var nationalAverages = {};
        metrics.forEach(function(metric) {
          var totalValue = districtFactors.aggregate_sum(metric);
          var numDistricts = districtFactors.size();
          var avg = ee.Number(totalValue).divide(numDistricts).getInfo();
          nationalAverages[metric] = avg.toFixed(4);
        });
  
        var comparisonPanel = ui.Panel({
          layout: ui.Panel.Layout.flow('vertical'),
          style: { margin: '5px auto', stretch: 'horizontal' }
        });
  
        comparisonPanel.add(ui.Label(
          translate('Comparison with National Average and Nearest Districts:') + ' ' + 
          (neighbor1Name ? capitalizeFirstLetter(neighbor1Name) : translate('N/A')) + ', ' + 
          (neighbor2Name ? capitalizeFirstLetter(neighbor2Name) : translate('N/A')),
          { fontSize: '12px', fontStyle: 'italic', color: STYLES.COLORS.TEXT_SECONDARY, margin: '2px 0', textAlign: 'center' }
        ));
        comparisonPanel.add(ui.Label(
          translate('Note: Nearest districts are determined by spatial proximity between districts centroids.'),
          { fontSize: '11px', fontStyle: 'italic', color: STYLES.COLORS.TEXT_MUTED, margin: '2px auto', textAlign: 'center' }
        ));
  
        var tablePanel = ui.Panel({
          layout: ui.Panel.Layout.flow('vertical'),
          style: { margin: '5px auto', stretch: 'horizontal', border: '1px solid #d1d5db' }
        });
  
        var headerRow = ui.Panel({
          layout: ui.Panel.Layout.flow('horizontal'),
          style: { margin: '2px 0', stretch: 'horizontal', backgroundColor: 'rgba(0, 0, 0, 0)' }
        });
        headerRow.add(ui.Label(translate('Metric'), { fontWeight: 'bold', width: '150px', padding: '4px' }));
        headerRow.add(ui.Label(capitalizeFirstLetter(districtName), { fontWeight: 'bold', width: '80px', padding: '4px', textAlign: 'center' }));
        headerRow.add(ui.Label(translate('National Avg'), { fontWeight: 'bold', width: '80px', padding: '4px', textAlign: 'center' }));
        headerRow.add(ui.Label(translate('Nearby Districts'), { fontWeight: 'bold', width: '100px', padding: '4px', textAlign: 'center' }));
        tablePanel.add(headerRow);
        tablePanel.add(ui.Panel({ style: { height: '1px', backgroundColor: '#d1d5db' } }));
  
        metrics.forEach(function(metric) {
          var districtValue = Number({
            incidentsPerKm2: incidentsPerKm2,
            deathsPerKm2: deathsPerKm2,
            injuriesPerKm2: injuriesPerKm2,
            infraDestroyedPerKm2: infraDestroyedPerKm2
          }[metric]) || 0;
          var nationalAvg = Number(nationalAverages[metric]) || 0;
  
          var displayDistrictValue = districtValue.toFixed(4);
          var displayNationalAvg = nationalAvg.toFixed(4);
          var neighborVals = [
            neighbor1Metrics[metric] || 0,
            neighbor2Metrics[metric] || 0
          ];
          var displayNeighborVals = neighborVals.map(function(val) {
            return val.toFixed(4);
          });
  
          var isAboveAvg = districtValue > nationalAvg;
          var districtColor = isAboveAvg ? STYLES.COLORS.HIGH_RISK : STYLES.COLORS.LOW_RISK;
  
          var row = ui.Panel({
            layout: ui.Panel.Layout.flow('horizontal'),
            style: { margin: '2px 0', stretch: 'horizontal', backgroundColor: 'rgba(0, 0, 0, 0)' }
          });
  
          row.add(ui.Label(metricLabels[metric], { width: '150px', padding: '4px', color: STYLES.COLORS.TEXT_SECONDARY }));
          row.add(ui.Label(displayDistrictValue, { width: '80px', padding: '4px', textAlign: 'center', color: districtColor, fontWeight: 'bold' }));
          row.add(ui.Label(displayNationalAvg, { width: '80px', padding: '4px', textAlign: 'center', color: STYLES.COLORS.TEXT_SECONDARY }));
          row.add(ui.Label(displayNeighborVals.join(', '), { width: '100px', padding: '4px', textAlign: 'center', color: STYLES.COLORS.TEXT_SECONDARY }));
  
          tablePanel.add(row);
          tablePanel.add(ui.Panel({ style: { height: '1px', backgroundColor: '#d1d5db' } }));
        });
  
        comparisonPanel.add(tablePanel);
        StatisticsPanel.add(comparisonPanel);
        districtSelect.setValue(districtName);
        hideLoadingMessage();
      });
    });
  }
  // Displays the national-level summary for Nepal
  function showFullSummary(isReset) {
    StatisticsPanel.clear();
    StatisticsPanel.add(ui.Label(translate('Loading...'), STYLES.SUBTITLE));
  
    var popSus = populationStats.get('popSus');
    
    ee.Dictionary({
      popSus: popSus,
      incidentCount: nationalStats.incidentCount,
      deaths: nationalStats.deaths,
      injuries: nationalStats.injuries,
      infrastructureDestroyed: nationalStats.infrastructureDestroyed
    }).evaluate(
      function(values) {
        StatisticsPanel.clear();
        var popSus = (values.popSus || [0, 0, 0]).map(function(v) { return Math.round(Number(v) || 0); });
        var totalPopulation = (popSus[0] + popSus[1] + popSus[2]) || 1;
        var popPercentages = {
          'Low Risk': totalPopulation > 0 ? Math.round((popSus[0] / totalPopulation) * 100) : 0,
          'Medium Risk': totalPopulation > 0 ? Math.round((popSus[1] / totalPopulation) * 100) : 0,
          'High Risk': totalPopulation > 0 ? Math.round((popSus[2] / totalPopulation) * 100) : 0
        };
        var incidentCountValue = Number(values.incidentCount) || 0;
        var deathsValue = Number(values.deaths) || 0;
        var injuriesValue = Number(values.injuries) || 0;
        var infraDestroyedValue = Number(values.infrastructureDestroyed) || 0;
        var susceptibilityChartData = ee.FeatureCollection([
          ee.Feature(null, {category: translate('Low Risk'), percentage: popPercentages['Low Risk']}),
          ee.Feature(null, {category: translate('Medium Risk'), percentage: popPercentages['Medium Risk']}),
          ee.Feature(null, {category: translate('High Risk'), percentage: popPercentages['High Risk']})
        ]);
        if (popPercentages['Low Risk'] + popPercentages['Medium Risk'] + popPercentages['High Risk'] === 0) {
          StatisticsPanel.add(createHistoricalIncidentsSection(incidentCountValue, deathsValue, injuriesValue, infraDestroyedValue));
          StatisticsPanel.add(createDividerPanel());
          StatisticsPanel.add(ui.Label('Risk Distribution and Population', STYLES.SECTION_TITLE));
          StatisticsPanel.add(ui.Label(translate('Risk Distribution: Unable to load population data. Showing historical incidents only.'), STYLES.SUBTITLE));
          if (highlightedDistrictLayer) {
            clearHighlightedDistrict();
          }
          Map.centerObject(NepalBoundary, 7);
          return;
        }
        StatisticsPanel.add(createHistoricalIncidentsSection(incidentCountValue, deathsValue, injuriesValue, infraDestroyedValue));
        StatisticsPanel.add(createDividerPanel());
        StatisticsPanel.add(ui.Label(translate('Population at Risk Distribution'), STYLES.SECTION_TITLE));
        var categories = [
          translate('Low Risk'),
          translate('Medium Risk'),
          translate('High Risk')
        ];
        var percentages = [
          popPercentages['Low Risk'],
          popPercentages['Medium Risk'],
          popPercentages['High Risk']
        ];
        var susceptibilityChart = ui.Chart.array.values(percentages, 0, categories)
          .setChartType('PieChart')
          .setOptions({
            colors: [STYLES.COLORS.LOW_RISK, STYLES.COLORS.MEDIUM_RISK, STYLES.COLORS.HIGH_RISK],
            width: 400,
            height: 160,
            fontSize: 12,
            chartArea: {width: '50%', height: '70%'},
            legend: { position: 'left', textStyle: { fontSize: 9 } },
            pieSliceText: 'percentage',
            pieSliceTextStyle: {color: '#000000', fontSize: 8, position: 'labeled'},
            sliceVisibilityThreshold: 0,
            tooltip: { trigger: 'none' }
          });
        StatisticsPanel.add(ui.Panel({
          widgets: [
            ui.Panel({ widgets: [susceptibilityChart], style: { margin: '0 auto' } })
          ],
          layout: ui.Panel.Layout.flow('horizontal', true),
          style: { margin: '5px 0', stretch: 'horizontal', textAlign: 'center' }
        }));
        StatisticsPanel.add(createDividerPanel());
        StatisticsPanel.add(ui.Label(translate('Critical Districts by Risk/Impact'), STYLES.SECTION_TITLE));
        var chartPanel = ui.Panel({
          style: { margin: '5px auto', textAlign: 'center' }
        });
        var metricSelect = ui.Select({
          items: [
            {label: translate('Reported Incidents'), value: 'incidentCount'},
            {label: translate('Reported Deaths'), value: 'deaths'},
            {label: translate('Reported Injuries'), value: 'injuries'},
            {label: translate('Infrastructure Impacted'), value: 'infraDestroyed'}
          ],
          value: 'deaths',
          style: { margin: '5px auto', stretch: 'horizontal', textAlign: 'center', width: '200px' }
        });
        function updateChart(metric) {
          chartPanel.clear();
          var topDistricts = districtFactors.sort(metric, false).limit(5);
          var totalValue = districtFactors.aggregate_sum(metric);
          var numDistricts = districtFactors.size();
          var nationalAvg = ee.Number(totalValue).divide(numDistricts).getInfo();
          var chartData = topDistricts.map(function(feature) {
            var value = ee.Number(feature.get(metric));
            var formattedValue = value.round();
            return ee.Feature(null, {
              district: feature.get('DISTRICT'),
              value: value.round(),
              deaths: feature.get('deaths'),
              infraDestroyed: feature.get('infraDestroyed'),
              displayValue: formattedValue
            });
          });
          chartData.evaluate(function(data) {
            var features = data.features || [];
            var formattedChartData = features.map(function(feature) {
              var districtName = capitalizeFirstLetter(feature.properties.district);
              return ee.Feature(null, {
                district: districtName,
                value: feature.properties.value,
                deaths: feature.properties.deaths,
                infraDestroyed: feature.properties.infraDestroyed,
                displayValue: feature.properties.displayValue
              });
            });
            var topDistrictsChart = ui.Chart.feature.byFeature(formattedChartData, 'district', 'value')
              .setChartType('ColumnChart')
              .setOptions({
                title: translate('Top 5 Districts by') + ' ' + translate(metricSelect.getValue()),
                hAxis: {
                  title: translate('Count'),
                  titleTextStyle: {bold: true}
                },
                vAxis: {
                  title: '',
                  titleTextStyle: {bold: true},
                  baseline: nationalAvg,
                  textStyle: {fontSize: 10, rotation: 45},
                  textPosition: 'out',
                  format: 'short'
                },
                legend: {position: 'none'},
                width: 400,
                height: 200,
                fontSize: 12,
                chartArea: {width: '70%', height: '70%'},
                bars: 'horizontal',
                annotations: {
                  stem: {color: 'gray', length: 10},
                  style: 'line',
                  textStyle: {color: 'gray', fontSize: 10}
                },
                tooltip: {trigger: 'both', isHtml: true},
                series: [{name: metricSelect.getValue()}],
                colors: ['#CD7F32']
              });
            topDistrictsChart.onClick(function(district) {
              if (district) {
                var originalDistrictName = district.toUpperCase();
                selectDistrict(originalDistrictName);
              }
            });
            chartPanel.add(topDistrictsChart);
          });
        }
        updateChart('deaths');
        StatisticsPanel.add(chartPanel);
        StatisticsPanel.add(ui.Label(translate('Select a metric to rank districts by impact and click on a bar to explore the district in detail.'), { fontSize: '12px', fontStyle: 'italic', color: STYLES.COLORS.TEXT_SECONDARY, margin: '5px 0', textAlign: 'center' }));
        StatisticsPanel.add(metricSelect);
        metricSelect.onChange(function(value) {
          updateChart(value);
        });
        StatisticsPanel.add(createDividerPanel());
  StatisticsPanel.add(ui.Button({
    label: translate('View Methodology'),
    onClick: function() {
      StatisticsPanel.clear();
      controlPanel.widgets().remove(districtInstructionLabel);
      controlPanel.widgets().remove(districtSelectPanel);
      Map.remove(legendPanel);
      Map.remove(languagePanel);
      ui.root.widgets().set(1, splitPanel);
      leftMap.setOptions('roadNetwork', { roadNetwork: roadNetwork });
      rightMap.setOptions('roadNetwork', { roadNetwork: roadNetwork });
  
      // Re-add layers to split maps
      var leftLayerVisibility = {};
      leftMap.layers().forEach(function(layer) {
        var untranslatedName = layer.untranslatedName;
        if (untranslatedName) {
          leftLayerVisibility[untranslatedName] = layer.getShown();
        }
      });
  
      var rightLayerVisibility = {};
      rightMap.layers().forEach(function(layer) {
        var untranslatedName = layer.untranslatedName;
        if (untranslatedName) {
          rightLayerVisibility[untranslatedName] = layer.getShown();
        }
      });
  
      leftMap.layers().reset();
      leftMap.layers().add(leftCountryBoundaryLayer);
      leftMap.layers().add(leftDistrictBoundariesLayer);
      leftMap.layers().add(leftProbabilityLayer);
  
      rightMap.layers().reset();
      rightMap.layers().add(rightCountryBoundaryLayer);
      rightMap.layers().add(rightDistrictBoundariesLayer);
      rightMap.layers().add(rightNormalizedRiskLayer);
  
      if (leftLayerVisibility['Country boundary']) leftCountryBoundaryLayer.setShown(leftLayerVisibility['Country boundary']);
      if (leftLayerVisibility['District Boundaries']) leftDistrictBoundariesLayer.setShown(leftLayerVisibility['District Boundaries']);
      if (leftLayerVisibility['RF Landslide Probability (Populated Areas)']) leftProbabilityLayer.setShown(leftLayerVisibility['RF Landslide Probability (Populated Areas)']);
      if (rightLayerVisibility['Country boundary']) rightCountryBoundaryLayer.setShown(rightLayerVisibility['Country boundary']);
      if (rightLayerVisibility['District Boundaries']) rightDistrictBoundariesLayer.setShown(rightLayerVisibility['District Boundaries']);
      if (rightLayerVisibility['Landslide Susceptibility (Populated Areas)']) rightNormalizedRiskLayer.setShown(rightLayerVisibility['Landslide Susceptibility (Populated Areas)']);
  
      leftMapTitle.setValue(translate('RF Landslide Probability (Populated Areas)'));
      rightMapTitle.setValue(translate('Landslide Susceptibility (Populated Areas)'));
  
      rightMap.add(legendPanel);
      leftMap.add(languagePanel);
      isInMethodologyView = true;
      var methodologyContent = createMethodologyContent('national', null);
      StatisticsPanel.add(methodologyContent);
      StatisticsPanel.style().set({
        shown: true,
        width: '500px',
        padding: '10px',
        backgroundColor: '#ffffff',
        borderRadius: '8px',
        position: 'top-right'
      });
      controlPanel.style().set({
        shown: true,
        maxWidth: '500px'
      });
  
      // Create a panel to hold both buttons side by side
      var buttonPanel = ui.Panel({
        layout: ui.Panel.Layout.flow('horizontal'),
        style: {
          margin: '14px auto',
          stretch: 'horizontal',
          textAlign: 'center',
        }
      });
  
      // Add the "Back to Statistics" button with adjusted width
      buttonPanel.add(ui.Button({
        label: translate('Back to Statistics'),
        onClick: function() {
          resetToNationalView();
        },
        style: { 
          backgroundColor: '#007bff', 
          width: '145px', // Reduced width to fit two buttons
          textAlign: 'center'
        }
      }));
  
      // Add the "More Details" button linking to the external URL
      buttonPanel.add(ui.Button({
        label: translate('More Details'),
        onClick: function() {
          window.open('https://maheer-maps.github.io/CASA25_Rasternauts/', '_blank');
        },
        style: { 
          backgroundColor: '#28a745', // Green color to differentiate
          width: '145px', // Matching width
          textAlign: 'center'
        }
      }));
  
      StatisticsPanel.add(buttonPanel);
    },
    style: { 
      margin: '14px auto', 
      backgroundColor: '#007bff', 
      width: '300px', 
      textAlign: 'center'
    }
  }));
  Map.centerObject(NepalBoundary, 7);
        districtSelect.setValue('National Overview');
      },
      function(error) {
        StatisticsPanel.clear();
        StatisticsPanel.add(ui.Label('Error loading national summary statistics: ' + error, {
          fontSize: '12px',
          color: STYLES.COLORS.HIGH_RISK,
          textAlign: 'center'
        }));
        StatisticsPanel.add(createHistoricalIncidentsSection(0, 0, 0, 0));
        StatisticsPanel.add(createDividerPanel());
        StatisticsPanel.add(ui.Label('Risk Distribution and Population', STYLES.SECTION_TITLE));
        StatisticsPanel.add(ui.Label('Unable to load full statistics. Showing placeholder data.', STYLES.SUBTITLE));
      }
    );
  }
  
  // ============================================================================
  // Section 10: Event Handlers
  // ============================================================================
  
  // Handles map clicks for district selection and landslide point details
  Map.onClick(function(coords) {
    if (isInMethodologyView) {
      return;
    }
  
    if (highlightedDistrictLayer && clippedLandslideFeatures && clippedLandslideFeatures.length > 0) {
      var clickRadius = 0.0027; // ~300 meters
      var matchingFeatures = [];
      var clickLon = coords.lon;
      var clickLat = coords.lat;
  
      clippedLandslideFeatures.forEach(function(feature) {
        var featureCoords = feature.geometry.coordinates;
        var featureLon = featureCoords[0];
        var featureLat = featureCoords[1];
        var distance = Math.sqrt(
          Math.pow(clickLon - featureLon, 2) + Math.pow(clickLat - featureLat, 2)
        );
        if (distance < clickRadius) {
          matchingFeatures.push(feature);
        }
      });
  
      if (matchingFeatures.length > 0) {
        var totalDeaths = 0;
        var totalInjuries = 0;
        var totalMissing = 0;
        var totalInfraDestroyed = 0;
        var incidentCount = matchingFeatures.length;
  
        matchingFeatures.forEach(function(feature) {
          var props = feature.properties || {};
          totalDeaths += props.peopleDeathCount || 0;
          totalInjuries += props.peopleInjuredCount || 0;
          totalMissing += props.peopleMissingCount || 0;
          totalInfraDestroyed += props.infrastructureDestroyedCount || 0;
        });
  
        var aggregatedData = {
          incidentCount: incidentCount,
          totalDeaths: totalDeaths,
          totalInjuries: totalInjuries,
          totalMissing: totalMissing,
          totalInfraDestroyed: totalInfraDestroyed
        };
        showLandslidePopup(aggregatedData, coords);
        return;
      }
      hideLandslidePopup();
    }
  
    var point = ee.Geometry.Point(coords.lon, coords.lat);
    NepalBoundary.geometry().contains(point).evaluate(function(isInside) {
      if (!isInside) {
        StatisticsPanel.clear();
        var widgets = controlPanel.widgets();
        if (widgets.indexOf(districtInstructionLabel) !== -1) {
          widgets.remove(districtInstructionLabel);
        }
        if (widgets.indexOf(districtSelectPanel) !== -1) {
          widgets.remove(districtSelectPanel);
        }
        if (widgets.get(2) && widgets.get(2).style().get('height') === '1px') {
          widgets.remove(widgets.get(2));
        }
        StatisticsPanel.add(ui.Label(translate('Click outside Nepal boundary. Please select a point within Nepal.'), STYLES.SUBTITLE));
        StatisticsPanel.add(ui.Button({
          label: translate('Reset to National Overview'),
          onClick: function() {
            resetToNationalView();
          },
          style: { margin: '10px auto', stretch: 'horizontal', textAlign: 'center' }
        }));
        return;
      }
  
      var clickedDistrict = districts.filterBounds(point).first();
      if (!clickedDistrict) {
        StatisticsPanel.clear();
        StatisticsPanel.add(ui.Label(translate('Nepal Landslides Risk Statistics'), STYLES.PANEL_TITLE));
        StatisticsPanel.add(ui.Label(translate('No district found at this location.'), STYLES.SUBTITLE));
        StatisticsPanel.add(ui.Button({
          label: translate('Reset to National Overview'),
          onClick: function() {
            resetToNationalView();
          },
          style: { margin: '10px auto', stretch: 'horizontal', textAlign: 'center' }
        }));
        return;
      }
  
      clickedDistrict.get('DISTRICT').evaluate(function(districtName) {
        districtName = districtName.trim().toUpperCase();
        if (currentDistrictName && currentDistrictName === districtName) {
          return;
        }
        selectDistrict(districtName);
        // Removed: initializeDistrictSelect() - Not needed here, already handled in selectDistrict and other state changes
      });
    });
  });
  
  // ============================================================================
  // Section 11: App Initialization
  // ============================================================================
  
  // Computes national aggregates at startup and caches them
  // Initializes the app after caching national statistics
  function initializeAppAfterCaching() {
    showFullSummary();
  
    controlPanel.widgets().add(StatisticsPanel);
    ui.root.clear();
    ui.root.add(controlPanel);
    ui.root.add(Map);
  
    Map.setControlVisibility({
      zoomControl: false,
      mapTypeControl: false,
      scaleControl: false,
      fullscreenControl: false
    });
    Map.drawingTools().setShown(false);
  
    leftMap.setControlVisibility({
      zoomControl: false,
      mapTypeControl: false,
      scaleControl: false,
      fullscreenControl: false
    });
    rightMap.setControlVisibility({
      zoomControl: false,
      mapTypeControl: false,
      scaleControl: false,
      fullscreenControl: false
    });
  
    Map.add(languagePanel);
    initializeDistrictSelect();
  
    var widgets = controlPanel.widgets();
    if (widgets.indexOf(districtInstructionLabel) !== -1) {
      widgets.remove(districtInstructionLabel);
    }
    if (widgets.indexOf(districtSelectPanel) !== -1) {
      widgets.remove(districtSelectPanel);
    }
    widgets.insert(2, districtInstructionLabel);
    widgets.insert(3, districtSelectPanel);
  }
  ee.Dictionary({
    incidentCount: districtFactors.aggregate_sum('incidentCount'),
    deaths: districtFactors.aggregate_sum('deaths'),
    injuries: districtFactors.aggregate_sum('injuries'),
    infrastructureDestroyed: districtFactors.aggregate_sum('infraDestroyed')
  }).evaluate(
    function(values) {
      nationalStats.incidentCount = Number(values.incidentCount) || 0;
      nationalStats.deaths = Number(values.deaths) || 0;
      nationalStats.injuries = Number(values.injuries) || 0;
      nationalStats.infrastructureDestroyed = Number(values.infrastructureDestroyed) || 0;
      initializeAppAfterCaching();
    },
    function(error) {
      nationalStats.incidentCount = 0;
      nationalStats.deaths = 0;
      nationalStats.injuries = 0;
      nationalStats.infrastructureDestroyed = 0;
      console.error('Error computing national stats: ', error);
      initializeAppAfterCaching();
    }
  );