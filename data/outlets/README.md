# Outlet countries

`countries.tsv.gz` gives each news outlet's home country. Discovery uses it to tell a theme apart from one country's local news (decision 61 in `.claude/MEMORY.md`).

- **Source:** GDELT, "Master Domain Country List", May 2018 update:
  `http://data.gdeltproject.org/blog/2018-news-outlets-by-country-may2018-update/MASTER-GDELTDOMAINSBYCOUNTRY-MAY2018.TXT`
  (downloaded 2026-09-29). GDELT's data is free and open for any use with attribution:
  "The GDELT Project, https://www.gdeltproject.org/".
- **Format:** gzipped, tab-separated, one outlet per line, with no header:
  `domain` (lower case), `country code` (FIPS 10-4, as GDELT writes it: `US`, `UK`,
  `AS` = Australia, `IN` = India), `country name`. There are 189,545 outlets, 56,160 of them in the US.
- **Coverage:** 98% of the market feed's articles over 2026-09-22..29 came from an outlet
  listed here. An outlet that is not listed has no country, and its articles count against a phrase's
  lead country. That errs towards keeping a phrase.
- **Rebuilding:** download the file above, then run
  `awk -F'\t' 'NF>=3 && $1!="" && $2!="" {print tolower($1)"\t"$2"\t"$3}' FILE | sort -u -t$'\t' -k1,1 | gzip -9n`.
  The list dates from 2018, so newer outlets are missing. A newer GDELT release can replace it; re-measure
  the rule before relying on the new file.
