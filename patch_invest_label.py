import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    "Amount to invest (USD)",
    "Amount to invest ({investCurrency})"
).replace(
    "المبلغ المراد استثماره (USD)",
    "المبلغ المراد استثماره ({investCurrency})"
).replace(
    "Amount to invest ({investCurrency})",
    "{`Amount to invest (${investCurrency})`}"
).replace(
    "المبلغ المراد استثماره ({investCurrency})",
    "{`المبلغ المراد استثماره (${investCurrency})`}"
).replace(
    "{tInvest('{`Amount to invest (${investCurrency})`}', '{`المبلغ المراد استثماره (${investCurrency})`}')}",
    "{tInvest(`Amount to invest (${investCurrency})`, `المبلغ المراد استثماره (${investCurrency})`)}"
)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
