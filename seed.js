const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'bloodbank_v2.db'));
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const SHELF = { 'Whole Blood': 35, 'RBC': 42, 'Platelets': 5, 'Plasma': 365 };

if (db.prepare('SELECT COUNT(*) c FROM donors').get().c > 0) { console.log('Demo data already exists'); process.exit(); }

// Donors: name, group, phone, city, gender, dob, weight, last donation (days ago), total
const insD = db.prepare('INSERT INTO donors(name,blood_group,phone,city,gender,dob,weight,last_donation,total_donations) VALUES(?,?,?,?,?,?,?,?,?)');
[
  ['Rahim Uddin', 'O-', '01711000001', 'Dhaka', 'Male', '1998-03-12', 68, -120, 3],
  ['Sabina Akter', 'A+', '01711000002', 'Dhaka', 'Female', '2002-07-21', 55, -200, 2],
  ['Karim Hossain', 'B+', '01711000003', 'Chattogram', 'Male', '1995-11-05', 74, -45, 4],
  ['Nusrat Jahan', 'AB+', '01711000004', 'Dhaka', 'Female', '2000-01-30', 58, null, 0],
  ['Tanvir Ahmed', 'O+', '01711000005', 'Sylhet', 'Male', '1992-09-17', 80, -100, 6],
  ['Mitu Rani', 'A-', '01711000006', 'Dhaka', 'Female', '1999-05-09', 52, -10, 1],
  ['Arif Islam', 'B-', '01711000007', 'Khulna', 'Male', '1997-12-25', 70, -150, 2],
  ['Farhana Yasmin', 'O+', '01711000008', 'Dhaka', 'Female', '2001-04-14', 60, -95, 3],
].forEach(d => insD.run(d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7] === null ? null : day(d[7]), d[8]));

// Donation history (for the monthly chart)
const insN = db.prepare("INSERT INTO donations(donor_id,date,component,hemoglobin,weight,bp,result,reason) VALUES(?,?,?,?,?,?,?,?)");
[[1, -120], [1, -210], [2, -200], [3, -45], [3, -140], [5, -100], [5, -190], [5, -280], [6, -10], [7, -150], [8, -95], [8, -180]]
  .forEach(([id, o]) => insN.run(id, day(o), 'Whole Blood', 13.5, 65, '120/80', 'accepted', null));

// Stock (some low, some expiring soon, one expired, AB- empty, so alerts show)
const insS = db.prepare('INSERT INTO stock(blood_group,component,collected,expiry) VALUES(?,?,?,?)');
const add = (g, c, n, ago) => { for (let i = 0; i < n; i++) insS.run(g, c, day(-ago), day(-ago + SHELF[c])); };
add('O-', 'Whole Blood', 6, 5); add('O-', 'RBC', 4, 8); add('O+', 'Whole Blood', 8, 3);
add('A+', 'Whole Blood', 7, 6); add('A-', 'Whole Blood', 2, 10); add('B+', 'Whole Blood', 5, 4);
add('B-', 'Whole Blood', 1, 12); add('AB+', 'Whole Blood', 3, 7);
add('A+', 'Platelets', 3, 1); add('O+', 'Plasma', 4, 20);
add('A+', 'Whole Blood', 2, 31);  // expires in 4 days
add('B+', 'Whole Blood', 1, 40);  // already expired

// Hospitals
const insH = db.prepare('INSERT INTO hospitals(name,city,phone) VALUES(?,?,?)');
insH.run('City General Hospital', 'Dhaka', '029000001');
insH.run('Green Life Hospital', 'Dhaka', '029000002');
insH.run('Care Medical Center', 'Chattogram', '031000003');

// Camps
const insC = db.prepare('INSERT INTO camps(title,location,date,expected,collected,status) VALUES(?,?,?,?,?,?)');
insC.run('University Blood Camp', 'Dhaka', day(5), 80, 0, 'upcoming');
insC.run('Community Donation Drive', 'Mirpur', day(12), 50, 0, 'upcoming');
insC.run('Eid Blood Camp', 'Uttara', day(-20), 60, 47, 'completed');

// Requests: entered Normal, Urgent, Emergency (Emergency must be served first)
const insR = db.prepare('INSERT INTO requests(patient,blood_group,component,units,priority,hospital,doctor,contact) VALUES(?,?,?,?,?,?,?,?)');
insR.run('Karim Ahmed', 'A+', 'Whole Blood', 2, 3, 'City General Hospital', 'Dr. Hasan', '01800000001');
insR.run('Nusrat Sultana', 'O-', 'RBC', 1, 2, 'Green Life Hospital', 'Dr. Rina', '01800000002');
insR.run('Rafiq Mia', 'B+', 'Whole Blood', 2, 1, 'City General Hospital', 'Dr. Hasan', '01800000003');

db.prepare("INSERT INTO logs(username,action) VALUES(?,?)").run('admin', 'Demo data loaded');
console.log('Demo data added!');