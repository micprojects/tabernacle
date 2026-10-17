// Original, local article text for Readability and native Firefox Reader View checks.
export const articlePage = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<title>A neighbourhood orchard | Field Notes</title>
<meta property="og:title" content="A neighbourhood orchard">
<meta name="author" content="Alex Green">
<meta name="description" content="How a small shared orchard became a place to grow fruit, learn practical skills and spend time together.">
<meta property="article:published_time" content="2026-10-17T09:00:00Z">
<style>body{font:18px/1.6 system-ui;max-width:720px;margin:40px auto;padding:20px}</style>
</head><body><header>Field Notes</header><nav><a href="/">Home</a></nav>
<main><article><h1>A neighbourhood orchard</h1><p class="byline">By Alex Green</p>
${[
  'The orchard began with a question about a piece of unused ground beside the library. A few neighbours wanted somewhere to grow fruit, but they also wanted a place where people could stop and talk. Before anyone bought a tree, the group spent several afternoons watching how sunlight moved across the site. They measured the space, checked the soil and asked the library staff which paths people used most often.',
  'Choosing trees turned out to be a useful way to learn about the place. Local growers explained which varieties suited the weather and which needed a partner nearby to produce fruit. The group chose a mixture of apples and pears with different harvest times. Smaller trees left room for paths, while a handful of larger specimens would eventually provide welcome shade for the benches.',
  'Planting day was deliberately simple. Volunteers marked each position with a stick and checked the distances again before digging. Someone brought a large flask of tea, and children helped carry the empty pots back to the gate. Every tree received a label with its variety and planting date. The labels made it easier for new volunteers to understand the plan without having attended the earlier meetings.',
  'Watering was the first practical challenge. A shared calendar helped, but the group quickly discovered that a regular evening visit worked better than a complicated rota. People could join the watering walk when they were free. During dry weather, pairs of volunteers checked the young trees carefully and recorded what they had done. Mulch helped the soil retain water and reduced competition from grass.',
  'The first harvest was modest, and that suited everyone. Instead of promising large quantities of fruit, the group organised a tasting table outside the library. Visitors compared several apple varieties and wrote down what they noticed about texture and flavour. A few people brought recipes from home. Those conversations shaped the next season more than any formal survey could have done.',
  'Maintaining the orchard created opportunities to share skills. A local gardener offered a pruning workshop and explained why small, careful cuts were preferable to dramatic changes. Volunteers practised identifying damaged branches and looking for healthy growth. The workshop ended with a walk around every tree, giving people time to ask questions and compare what they had learned with what they could see.',
  'The space also needed to work for people who were not interested in gardening. The paths were kept clear, the benches were placed where conversation felt comfortable, and signs used ordinary language. Nobody needed to join a committee to sit beneath a tree. This everyday use helped the orchard become part of the neighbourhood instead of a project that only its founders understood.',
  'Several years later, the most useful lesson is still the one from the beginning: pay attention before making a decision. The orchard changes with the seasons, and its volunteers change too. A small notebook in the library records successes, mistakes and ideas for another year. It gives the next person enough information to continue the work while leaving them room to improve it.',
]
  .map((text) => `<p>${text}</p>`)
  .join('\n')}
</article></main><footer><a href="/contact">Contact Field Notes</a></footer></body></html>`;
