import re

with open('src/components/AdminProducts.tsx', 'r') as f:
    content = f.read()

# Add pro_price to Options parsing
opt_parse_old = "options: parsedOpts.map(o => ({...o, cost: (o.cost||0)*exchangeRate, price: (o.price||0)*exchangeRate, original_price: (o.original_price||0)*exchangeRate})),"
opt_parse_new = "options: parsedOpts.map(o => ({...o, cost: (o.cost||0)*exchangeRate, price: (o.price||0)*exchangeRate, original_price: (o.original_price||0)*exchangeRate, pro_price: (o.pro_price||0)*exchangeRate, name_ar: o.name_ar||''})),"
content = content.replace(opt_parse_old, opt_parse_new)

# Add pro_price to Colors parsing
col_parse_old = "colors: parsedCols.map(c => ({...c, cost: (c.cost||0)*exchangeRate, price: (c.price||0)*exchangeRate, original_price: (c.original_price||0)*exchangeRate})),"
col_parse_new = "colors: parsedCols.map(c => ({...c, cost: (c.cost||0)*exchangeRate, price: (c.price||0)*exchangeRate, original_price: (c.original_price||0)*exchangeRate, pro_price: (c.pro_price||0)*exchangeRate, option_id: c.option_id||'', name_ar: c.name_ar||''})),"
content = content.replace(col_parse_old, col_parse_new)

# Add them in save DB
opt_stringify_old = "JSON.stringify(form.options.map((o: any) => ({...o, cost: o.cost/exchangeRate, price: o.price/exchangeRate, original_price: o.original_price/exchangeRate}))),"
opt_stringify_new = "JSON.stringify(form.options.map((o: any) => ({...o, cost: o.cost/exchangeRate, price: o.price/exchangeRate, original_price: o.original_price/exchangeRate, pro_price: o.pro_price/exchangeRate, name_ar: o.name_ar}))),"
content = content.replace(opt_stringify_old, opt_stringify_new)

col_stringify_old = "JSON.stringify(form.colors.map((c: any) => ({...c, cost: c.cost/exchangeRate, price: c.price/exchangeRate, original_price: c.original_price/exchangeRate}))),"
col_stringify_new = "JSON.stringify(form.colors.map((c: any) => ({...c, cost: c.cost/exchangeRate, price: c.price/exchangeRate, original_price: c.original_price/exchangeRate, pro_price: c.pro_price/exchangeRate, option_id: c.option_id, name_ar: c.name_ar}))),"
content = content.replace(col_stringify_old, col_stringify_new)

# Initial Form Options
content = content.replace("{ id: 'opt_'+Date.now(), name: '', image: '', price: 0, original_price: 0, cost: 0 }", "{ id: 'opt_'+Date.now(), name: '', name_ar: '', image: '', price: 0, original_price: 0, cost: 0, pro_price: 0 }")
content = content.replace("{ id: 'col_'+Date.now(), name: '', hex: '', image: '', price: 0, original_price: 0, cost: 0 }", "{ id: 'col_'+Date.now(), name: '', name_ar: '', hex: '', image: '', price: 0, original_price: 0, cost: 0, pro_price: 0, option_id: '' }")


with open('src/components/AdminProducts.tsx', 'w') as f:
    f.write(content)
