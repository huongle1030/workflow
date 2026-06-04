// Quality Control mode catalogs — ported verbatim from qc-app_AOX so the suite's
// QC Reject / Internal Remake forms offer identical options and write identical
// data. Sources: qc-app_AOX/src/pages/QCLogPage.jsx (lines 8–39) and
// qc-app_AOX/src/lib/teamsData.js. Keep these in sync with the qc-app if it changes.

export const REJECT_TYPES_BY_TEAM = {
  Design: ['ASC Dimples Not Designed','Design — Files Not Placed for Milling','Design — Massive Overjet / Occlusion Issue','Design — Missing Model / Soft Tissue','Design — Not Millable','Design Error','Fracture caused due to design error','Incorrect screw design','No Clearance Around MUA','No upper arch design','Open Implants Not Used','Rx not followed','TRI Matrix Info Incorrect — Screws, Platforms','Wrong design','Other'],
  PMMA: ['Acrylic / Cement Gap Fill','Debris in Interface','Debonded Ti','Excess Glaze','Finish-Dull, Rough spots','Finish-Scratches, Gouges, Embedded Debris','Finish-Symmetry','Gum Shade','Incomplete Cleaning / Residual Material','Incorrect Cementing','Intaglio Polish','Internal Glaze Contamination','LFX Housing','Missing glaze','Missing Product','Missing Tissue','MUA Interface Damage','No Clearance Around MUA','Rx not followed','Scanning Issue','Screw Access','Screw channel-Fitted, Dirty','Seating issues on model','Surface Porosity / Bubbles','Ti Base not Cemented','Tooth Shade','Other'],
  Zirconia: ['Combo Case — Denture Seating Issue','Debris in Interface','Finish-Dull, Rough spots','Finish-Scratches, Gouges, Embedded Debris','Finish-Symmetry','Gum Shade','Incomplete Cleaning / Residual Material','Incorrect Cementing','Intaglio Polish','Internal Glaze Contamination','Missing Product','Missing Tissue','MUA Interface Damage','No Clearance Around MUA','Rx not followed','Scanning Issue','Screw Access','Structure Separation','Surface Porosity / Bubbles','Ti Base not Cemented','TRI Matrix Info Incorrect — Screws, Platforms','Tooth Shade','Other'],
  Bars: ['Acrylic / Cement Gap Fill','Design Error','Finish-Scratches, Gouges, Embedded Debris','Incorrect Cementing','Intaglio Polish','LFX Housing','Missing Documentation','Missing Product','Other','Seating issues on model','Shade Adjustment'],
  Milling: ['Bad Print','Finish-Scratches, Gouges, Embedded Debris','MUA Interface Damage','Other','Scanning Issue'],
  Printing: ['Bad Print','Seating issues on model','Other'],
  'Case Entry': ['Case Entry Error — Wrong Account','Rx not followed','Other'],
  'Case Review': ['Missing Product','Rx not followed','Other'],
  'Case Coordination': ['Other'],
  'Place Parts': ['Missing Screws','Missing Product','Finish-Scratches, Gouges, Embedded Debris','Other'],
  Scanning: ['Scanning Issue','Other'],
  'Shape and Colorize': ['Gum Shade','Tooth Shade','Scanning Issue','Other'],
  'Design QC': ['Finish-Scratches, Gouges, Embedded Debris','Rx not followed','Other'],
  'Design Adjustments': ['Design Error','Other'],
};

export const DEFAULT_REJECT_TYPES = ['Finish-Scratches, Gouges, Embedded Debris','Finish-Dull, Rough spots','Screw Access','Incorrect Cementing','Missing Product','Rx not followed','Other'];

// Urgency pills. `slug` maps to a .cc-action-badge variant defined in qc/styles.css.
export const QC_REJECT_OPTIONS = [
  { value: 'Repair',          slug: 'qc-repair',   color: '#3B6D11', bg: '#EAF3DE', border: '#97C459' },
  { value: 'ASAP(Same day)',  slug: 'qc-asap',     color: '#854F0B', bg: '#FAEEDA', border: '#EF9F27' },
  { value: 'Next Day',        slug: 'qc-nextday',  color: '#185FA5', bg: '#E6F1FB', border: '#85B7EB' },
  { value: 'Remake',          slug: 'qc-remake',   color: '#A32D2D', bg: '#FCEBEB', border: '#F09595' },
  { value: 'Internal Remake', slug: 'qc-internal', color: '#534AB7', bg: '#EEEDFE', border: '#AFA9EC' },
];

// Department list used by the Internal Remake form (QCLogPage.jsx line 33).
export const DEPARTMENTS = ['PMMA','Zirconia','Bars','Design','Design QC','Design Adjustments','Milling','Printing','Scanning','Shape and Colorize','Place Parts','Case Entry','Case Review','Case Coordination'];

// Departments offered in the QC Reject form's Department dropdown (teamsData.js TEAMS).
export const TEAMS = ['PMMA','Zirconia','Bars','Case Entry','Case Review','Place Parts','Scanning','Design','Design Adjustments','Design QC','Case Coordination','Milling','Shape and Colorize','Printing'];

export const TECHNICIANS_BY_TEAM = {
  'PMMA': ['Adriana Ballesteros','Graciela Sebastian','Lihn To','Mary Gurrola','Samuel Lopez','Valeria Silva'],
  'Zirconia': ['Briana Lopez','Chae Jung','Emma Solis','Jung Mi Lee','Maria Vargas','Samuel Lopez','Sangchul Kang'],
  'Bars': ['Arturo Figueroa','Chloe Lopez','Jimmy Cabugao','Manuel Perez','Said Lara'],
  'Case Entry': ['Kevin Martinez','Tatiana Aguilar'],
  'Case Review': ['Anais Romo','Ceasar Ramos','Fabiola Gaminovilla'],
  'Place Parts': ['Fabiola Gaminovilla','Josh cendejas'],
  'Scanning': ['Armita Bastanizadeh'],
  'Design': ['Andrew','Andy','Enoch','James','Raul','Sophia Galvan','Thomas'],
  'Design Adjustments': ['Design Adj Team'],
  'Design QC': ['Design Team'],
  'Case Coordination': ['Alan','Anais','Jaypee','Samuel Giles'],
  'Milling': ['Jonathan Phan','Josh Chambers','Liz Corona'],
  'Shape and Colorize': ['Samuel and Team'],
  'Printing': ['Print Team'],
};

// Technical experts notified on staging / internal-remake (QCLogPage.jsx line 36).
export const EXPERTS = [
  { name: 'Jeannette Rubio', email: 'jeannette.rubio@skdla.com' },
  { name: 'Ryan Okon',       email: 'ryan.okon@skdla.com' },
];

// Project anon JWT — used ONLY for the notify-expert-staged edge function call.
// The suite's REST data path uses the publishable key, but the edge function
// gateway expects a JWT apikey (the publishable key is not a JWT). This is the
// same already-public anon key the qc-app ships in its browser bundle.
export const EDGE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFzZHVua3FvZGl4Ymhib2h4dHVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyNDUwNTcsImV4cCI6MjA5MDgyMTA1N30.lStrSSEpwFFk5GuXl2qzh2tr6bLZFY4_x9u6q4FcVeo';
