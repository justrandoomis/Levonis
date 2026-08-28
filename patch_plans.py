import re

with open('src/pages/Subscription.tsx', 'r') as f:
    content = f.read()

old_plans = """  const plans = {
    plus: [
      { id: '1mo', number: '1', unit: t('month'), pricePerUnitIQD: 3500, savings: null, badge: t('new'), cost: 3500, days: 30 },
      { id: '3mo', number: '3', unit: t('months'), pricePerUnitIQD: 3000, savings: '-14%', badge: null, cost: 9000, days: 90 },
      { id: '6mo', number: '6', unit: t('months'), pricePerUnitIQD: 2666, savings: '-24%', badge: t('mostPopular'), cost: 16000, days: 180 },
      { id: '1yr', number: '1', unit: t('year'), pricePerUnitIQD: 2416, savings: '-31%', badge: null, cost: 29000, days: 365 },
    ],
    pro: [
      { id: '1mo', number: '1', unit: t('month'), pricePerUnitIQD: 45000, savings: null, badge: t('new'), cost: 45000, days: 30 },
      { id: '3mo', number: '3', unit: t('months'), pricePerUnitIQD: 38333, savings: '-15%', badge: null, cost: 115000, days: 90 },
      { id: '6mo', number: '6', unit: t('months'), pricePerUnitIQD: 33333, savings: '-25%', badge: null, cost: 200000, days: 180 },
      { id: '1yr', number: '1', unit: t('year'), pricePerUnitIQD: 27500, savings: '-38%', badge: t('mostPopular'), cost: 330000, days: 365 },
    ]
  };"""

new_plans = """  const plans = {
    plus: [
      { id: '1mo', number: '1', unit: t('month'), pricePerUnitIQD: 4500, savings: null, badge: null, cost: 4500, days: 30 },
      { id: '3mo', number: '3', unit: t('months'), pricePerUnitIQD: 3900, savings: '-13%', badge: null, cost: 11700, days: 90 },
      { id: '6mo', number: '6', unit: t('months'), pricePerUnitIQD: 3300, savings: '-26%', badge: t('mostPopular'), cost: 19800, days: 180 },
      { id: '1yr', number: '1', unit: t('year'), pricePerUnitIQD: 2800, savings: '-37%', badge: null, cost: 33600, days: 365 },
    ],
    pro: [
      { id: '6mo', number: '6', unit: t('months'), pricePerUnitIQD: 45000, savings: null, badge: null, cost: 270000, days: 180 },
      { id: '1yr', number: '1', unit: t('year'), pricePerUnitIQD: 37500, savings: '-16%', badge: t('mostPopular'), cost: 450000, days: 365 },
    ]
  };"""

content = content.replace(old_plans, new_plans)

with open('src/pages/Subscription.tsx', 'w') as f:
    f.write(content)
