const target = new URL('./', location.href);
target.search = location.search;
location.replace(target);
