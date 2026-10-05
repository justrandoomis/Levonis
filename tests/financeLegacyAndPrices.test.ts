import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {freshDb,asD1,stubApp,get,post,json,count,row} from './fixtures/app';
import {adminInvestmentFinanceRoutes} from '../worker/routes/adminInvestmentFinance';
import {financeEarningsRoutes} from '../worker/routes/financeEarnings';
import {adminProductsRoutes} from '../worker/routes/adminProducts';
import {adminRoutes} from '../worker/routes/admin';

test('legacy USD cents and forecasts remain historical; investor account sees only its own records',async()=>{
 const raw=freshDb();raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES('boss','boss@x.co','Owner','admin','full'),('one','one@x.co','Investor','admin','assistant'),('two','two@x.co','Other','admin','assistant');
 INSERT INTO investments(id,user_id,amount_usd_cents,expected_profit_usd_cents,start_date,end_date) VALUES ('old-one','one',10000,3500,'2025-01-01','2025-12-31'),('old-two','two',20000,7000,'2025-01-01','2025-12-31');`);
 const db=asD1(raw),app=(id:string,scope='assistant')=>stubApp(db,{id,email:`${id}@x.co`,role:'admin',admin_scope:scope},a=>{a.route('/i',adminInvestmentFinanceRoutes);a.route('/e',financeEarningsRoutes);a.route('/a',adminRoutes);});
 const self=app('one'),boss=app('boss','full');const history=await json(await get(self,'/e/legacy'));assert.equal(history.currency,'USD');assert.equal(history.unit,'cent');assert.equal(history.withdrawable,false);assert.equal(history.investments.length,1);assert.equal(history.investments[0].amount_usd_cents,10000);
 assert.equal((await json(await get(self,'/e'))).summary.available_iqd,0);assert.equal((await get(self,'/i/legacy')).status,403);
 assert.equal((await post(boss,'/i/legacy/old-one/link',{evidence:'Historical forecast, not an actual delivered allocation.'})).status,200);assert.equal(count(raw,'SELECT COUNT(*) n FROM finance_investor_earnings'),0);
 assert.equal((await post(boss,'/a/invest/users/one/investments',{amount_usd_cents:100})).status,410);assert.equal(count(raw,'SELECT COUNT(*) n FROM investments'),2);
 const appSource=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');assert.ok(!appSource.includes("import('./pages/Invest')"));assert.ok(!appSource.includes("import('./pages/InvestAdmin')"));assert.equal((appSource.match(/path="\/invest" element={<ProtectedRoute><LegacyInvestmentRedirect \/>/g)||[]).length,2);
});

test('a reference selling price updates only the chosen option, records price history and rejects stale edits',async()=>{
 const raw=freshDb();raw.exec(`INSERT INTO users(id,email,role,admin_scope) VALUES ('boss','boss@x.co','admin','full'),('helper','helper@x.co','admin','assistant');
 INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode,options) VALUES('p','Printer','price-option',100000,0,'OPTION','[{"id":"a","regular_price_iqd":120000},{"id":"b","regular_price_iqd":150000}]');
 INSERT INTO product_option_groups(id,product_id,name_en) VALUES('g','p','Model');
 INSERT INTO product_option_values(id,product_id,group_id,name_en,regular_price_iqd,stock) VALUES('a','p','g','Combo',120000,0),('b','p','g','Basic',150000,0);`);
 const db=asD1(raw),app=(helper=false)=>stubApp(db,{id:helper?'helper':'boss',email:helper?'helper@x.co':'boss@x.co',role:'admin',admin_scope:helper?'assistant':'full'},a=>a.route('/p',adminProductsRoutes));
 const body={scope:'option',scope_id:'a',expected_price_iqd:120000,price_iqd:130000};const response=await post(app(),'/p/p/selection-price',body);assert.equal(response.status,200,JSON.stringify(await json(response)));
 assert.equal(count(raw,"SELECT regular_price_iqd n FROM product_option_values WHERE id='a'"),130000);assert.equal(count(raw,"SELECT regular_price_iqd n FROM product_option_values WHERE id='b'"),150000);assert.equal(JSON.parse(String(row(raw,"SELECT options FROM products WHERE id='p'")!.options))[0].regular_price_iqd,130000);assert.equal(count(raw,'SELECT COUNT(*) n FROM price_history'),1);
 assert.equal((await post(app(),'/p/p/selection-price',{...body,price_iqd:140000})).status,409);assert.equal((await post(app(true),'/p/p/selection-price',body)).status,403);
});
