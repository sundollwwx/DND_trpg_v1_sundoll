"use strict";

(() => {
  const button = document.getElementById("roll-dice");
  const face = document.getElementById("dice-face-value");
  const result = document.getElementById("dice-result");
  const resultRoll = document.getElementById("dice-result-roll");
  const eventTitle = document.getElementById("dice-event-title");
  const eventText = document.getElementById("dice-event-text");
  if (!button || !face || !result || !resultRoll || !eventTitle || !eventText) return;

  const events = [
    {"title":"鹅的通缉令","text":"你只是路过一个安静美丽的湖边，突然就被一只体型肥硕的巨鹅嚷嚷着追了三条街。它叼走了你珍贵的鞋带，像是收缴了价值连城的战利品。"},
    {"title":"勇者成鹅","text":"老板望着你，热情高喊“欢迎勇鹅”，整间酒馆忽然安静。门外一只挺胸阔步的白鹅闻声昂首踏进酒馆，接受了这份意外的欢迎。"},
    {"title":"披风还是猫窝","text":"一只三花小猫慵懒的趴在你的披风上睡着了。你刚想起身，小猫就翻了个面，露出一副像是说这不许抢我被窝的凶狠而可爱的表情。"},
    {"title":"宝箱有礼啦","text":"你费劲千辛万苦打开一个金光闪闪的宝箱，里面只有一张小小的纸条：“谢谢你冒险家，帮我打开透气，我都快闷坏了。”箱盖说完，自己满意地合上了。"},
    {"title":"口袋在鼓掌","text":"来到柜台，你想潇洒地付钱，口袋却传出热烈掌声，硬币一枚没出现，旁边的吟游诗人先鞠了躬，而酒馆的保镖食人魔却堵住了门口。"},
    {"title":"谁是路牌","text":"两个路牌各自指向对方，都说那里才是目的地。你叹了口气，掏出了地图。"},
    {"title":"蘑菇座椅","text":"路边的蘑菇看到疲惫的你，让出一个座位，你惬意的躺下去，却被孢子粉尘呛的满地打滚。"},
    {"title":"影子也要下班","text":"你的影子突然伸了个大大的懒腰，离开你坐到树下休息，挥手指向落日，和你示意表示今天已经站得够久了。"},
    {"title":"面包有意见","text":"刚出炉的热气腾腾的面包却长着一张严肃的脸。你奇怪地盯着它，它也愤懑的盯着你，直到你在它脸上涂满香香的果酱。"},
    {"title":"来自鸽子的委托","text":"一只信鸽向你郑重递来一封密信，里面只有一幅面包画像。它眼巴巴地看着你，显然认为事情已经说清了。"},
    {"title":"杯中风暴","text":"你的茶杯里刮起一场小小的暴风雨，一艘纸船在风浪里颠簸，船长朝你挥手求援，请求加两块白砂方块糖。"},
    {"title":"月亮打了嗝","text":"月亮忽然打了个嗝，吐出一小片银色云朵，伴随着闪烁美丽的星星，你们走在路上，享受着美妙的月色。"},
    {"title":"石像也会冷笑话","text":"广场里的石像智者讲了一个非常冷的笑话。没人笑，连喷泉小子都停了两秒；它清清嗓子，决定再讲一个，而你往他嘴里塞了一个泡泡糖。"},
    {"title":"暗号","text":"你随口说了句“传奇归来”，竟对上了旅店今天的秘密暗号。老板开心一笑，端来一块写着传奇两字的热腾腾的南瓜派。"},
    {"title":"星星点灯","text":"一颗小星星落在窗沿点亮了你的桌灯，平静的夜晚又多了一份陪伴。"},
    {"title":"猫咪的认可","text":"酒馆最挑剔的白猫主动蹭了蹭你的手。老板十分震惊，直接宣布你可以坐它旁边的那张椅子，并赐予你咪咪骑士的称号"},
    {"title":"好歌就差你","text":"你恰好赶上营地里吟游诗人的最后一首歌。他指向空着的位置，说今晚的好故事就差你来听。"},
    {"title":"宝藏自己上门","text":"你在路上捡到一枚旧金币，背面的地图竟然指向脚下！迅速挖开之后获得了另一枚金币。另一枚金币背面的地图居然指向地面，你想了想，揣着两个金币去买酒喝了。"},
    {"title":"顺利上钩","text":"你在岩浆边钓到了很多金光闪闪的鱼，一箩筐的美味！"},
    {"title":"雨过天晴","text":"出发之日，风平浪静，雨过天晴"},
  ];

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let rolling = false;
  button.disabled = false;

  function rollD20() {
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      const values = new Uint32Array(1);
      const limit = Math.floor(2 ** 32 / 20) * 20;
      do {
        window.crypto.getRandomValues(values);
      } while (values[0] >= limit);
      return (values[0] % 20) + 1;
    }
    return Math.floor(Math.random() * 20) + 1;
  }

  button.addEventListener("click", () => {
    if (rolling) return;
    rolling = true;
    button.classList.remove("is-result");
    button.classList.add("is-rolling");
    button.setAttribute("aria-busy", "true");
    result.setAttribute("aria-busy", "true");
    result.classList.remove("is-revealed");
    const value = rollD20();
    const reveal = () => {
      const event = events[value - 1];
      face.textContent = String(value);
      resultRoll.textContent = `掷得 · ${value}`;
      eventTitle.textContent = event.title;
      eventText.textContent = event.text;
      resultRoll.hidden = false;
      eventText.hidden = false;
      result.hidden = false;
      result.classList.remove("is-idle");
      result.classList.add("is-revealed");
      result.removeAttribute("aria-busy");
      button.classList.remove("is-rolling");
      button.classList.add("is-result");
      button.removeAttribute("aria-busy");
      rolling = false;
    };
    window.setTimeout(reveal, reducedMotion.matches ? 0 : 550);
  });
})();
