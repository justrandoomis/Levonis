import type { MemoryMedia } from './media';
export function completeTxt(media: MemoryMedia) {
  let txt = `template_version=2
name_en=A1 mini
name_ar=A1 mini
slug=lifecycle-a1-mini
price_iqd=499000
product_cost_iqd=300000
selling_type=mixed
catalogs=printers
standard_delivery_enabled=true
standard_delivery_quantity_step=2
standard_delivery_fee_iqd=10000
personal_delivery_enabled=true
personal_delivery_quantity_step=1
personal_delivery_fee_iqd=25000
spec_groups.1.id=specs
spec_groups.1.title_ar=المواصفات
usage_guide.official_url=https://bambulab.com/guide
`;
  for (let i=1; i<=2; i++) {
    txt += `options.${i}.id=model-${i}\noptions.${i}.name_en=A1 mini${i === 2 ? ' Combo' : ''}\noptions.${i}.regular_price_iqd=${i === 1 ? 499000 : 679000}\noptions.${i}.direct.enabled=true\noptions.${i}.direct.regular_price_iqd=${i === 1 ? 549000 : 699000}\noptions.${i}.direct.stock=5\noptions.${i}.preorder.enabled=true\n`;
    for (const [j, method] of ['sea','land','air'].entries()) txt += `options.${i}.preorder.transports.${j+1}.method=${method}\noptions.${i}.preorder.transports.${j+1}.enabled=true\noptions.${i}.preorder.transports.${j+1}.surcharge_iqd=${[0,30000,80000][j]}\noptions.${i}.preorder.transports.${j+1}.lead_time_min_days=${[21,14,7][j]}\noptions.${i}.preorder.transports.${j+1}.lead_time_max_days=${[28,21,12][j]}\n`;
  }
  for(let i=1;i<=3;i++) txt += `colors.${i}.id=color-${i}\ncolors.${i}.name_en=Color ${i}\ncolors.${i}.hex=#000000\n`;
  for(let i=1;i<=5;i++) {
    const key=`products/fixture/gallery/${i}.webp`; media.objects.set(key, new Uint8Array([i,2,3,4]));
    txt += `images.${i}.id=image-${i}\nimages.${i}.url=/files/${key}\nimages.${i}.key=${key}\ncontent_blocks.${i}.id=content-${i}\ncontent_blocks.${i}.kind=image\ncontent_blocks.${i}.url=/files/${key}\n`;
  }
  for(let i=1;i<=39;i++) txt += `spec_groups.1.rows.${i}.id=spec-${i}\nspec_groups.1.rows.${i}.label_ar=Spec ${i}\nspec_groups.1.rows.${i}.value_ar=Value ${i}\n`;
  for(let i=1;i<=2;i++) txt += `warranty_plans.${i}.id=warranty-${i}\nwarranty_plans.${i}.title_ar=Warranty ${i}\nwarranty_plans.${i}.duration_kind=extension\nwarranty_plans.${i}.duration_months=${12*i}\nwarranty_plans.${i}.fee_iqd=${i*10000}\n`;
  for(let i=1;i<=10;i++) txt += `usage_steps.${i}.id=step-${i}\nusage_steps.${i}.kind=setup\nusage_steps.${i}.title=Step ${i}\nusage_steps.${i}.body=Details ${i}\n`;
  return txt;
}
