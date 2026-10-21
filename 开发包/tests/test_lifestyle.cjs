const { DAILY_LIFE_FIXTURE } = require('./project_paths.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const lib=require('../../程序包/主程序/主控台/shared/lifestyle.js');
const data=JSON.parse(fs.readFileSync(path.resolve(DAILY_LIFE_FIXTURE,'资料/lifestyle.json'),'utf8'));
const base={people:4,days:3,tier:'modest',mealTier:'modest',roomTier:'modest',mealsPerDay:3,nights:3};
test('2024 meal quotes use per-meal rates, separate from nightly lodging',()=>{
 const q=lib.quote(data,{...base,mode:'itemized'});
 assert.deepEqual(q.lines.map(l=>l.cp),[360,600]);assert.equal(q.totalCp,960);
 assert.equal(lib.money(q.totalCp),'9 金币 6 银币');
});
test('a lifestyle quote never double bills the itemized inputs',()=>{
 const q=lib.quote(data,{...base,mode:'lifestyle',nights:365,mealsPerDay:6});
 assert.equal(q.totalCp,1200);assert.equal(q.lines.length,1);
 assert.equal(lib.quote(data,{...base,mode:'lifestyle',tier:'aristocratic'}).minimum,true);
 assert.match(lib.quote(data,{...base,mode:'lifestyle',tier:'wretched'}).note,/不保证/);
});
test('partial stays can have no meals or no nights; invalid quantities never become money',()=>{
 assert.equal(lib.quote(data,{...base,mode:'itemized',mealsPerDay:0,nights:0}).totalCp,0);
 for(const [key,value] of [['people',0],['people',101],['days',1.5],['nights',-1],['mealsPerDay',7],['days','oops']])assert.throws(()=>lib.quote(data,{...base,mode:'itemized',[key]:value}));
 assert.throws(()=>lib.quote(data,{...base,mode:'itemized',roomTier:'secret'}));
 assert.throws(()=>lib.quote(data,{...base,mode:'mystery'}));
});
test('data is a versioned general-module reference with six venues and unique flavor rows',()=>{
 assert.equal(data.edition.id,'dnd-2024-srd-5.2.1');
 assert.deepEqual(data.expenses.meals.map(t=>t.perMealCp),[1,2,10,20,30,60]);
 assert.deepEqual(data.expenses.lodging.map(t=>t.perNightCp),[7,10,50,80,200,400]);
 const flavor=JSON.parse(fs.readFileSync(path.resolve(DAILY_LIFE_FIXTURE,'资料/flavor.json'),'utf8'));
 assert.equal(flavor.venues.length,6);assert.equal(flavor.cultures.length,6);
 for(const t of flavor.tables){assert.deepEqual(t.rows.map(r=>r.roll),Array.from({length:20},(_,i)=>i+1));assert.equal(new Set(t.rows.map(r=>r.title)).size,20);}
});
