import {
  AGGIETIME_URI,
  AGGIETIME_DOMAIN,
  USER_PATH,
  USER_CACHE_EXP_SEC,
  CLOCKIN_PATH,
  CLOCKOUT_PATH,
  SUMMARY_PATH,
  OPEN_SHIFT_PATH,
  OPEN_SHIFT_EXP_SEC,
  PAST_WEEK_EXP_SEC,
} from "./constants.js";

import { with_exponential_retry } from "./exponential_retry.js";
import { client } from "./axios_client.js";

import expireCache from "expire-cache";

const aggietime = client.create({
  baseURL: AGGIETIME_URI,
});

const replace_path_args = (path, map) =>
  path.replaceAll(/:([a-zA-Z0-9_]+)/g, (_, key) => map[key]);

const get_user_position_or_specified = async (position_id) => {
  const { positions } = await get_user_info();

  if (position_id === undefined) {
    if (positions.length != 1) {
      throw "Must specify a position when there's not only one to choose from";
    }
    return positions[0];
  }

  return position_id;
};

export const get_user_info = async () => {
  if (!expireCache.get("user")) {
    const user = await with_exponential_retry(() =>
      aggietime.get(USER_PATH).then(({ data, config }) => {
        const csrf_token = config.jar
          .toJSON()
          .cookies.find(
            ({ domain, key }) =>
              domain === AGGIETIME_DOMAIN && key === "XSRF-TOKEN",
          ).value;
        expireCache.set("aggietime-csrf", csrf_token);
        return data;
      }),
    );

    expireCache.set("user", user, USER_CACHE_EXP_SEC);
  }
  return expireCache.get("user");
};

const do_clock_mutation = async (path, { position_id } = {}) => {
  position_id = await get_user_position_or_specified(position_id);

  return await aggietime
    .post(
      replace_path_args(path, { position_id }),
      {
        comment: "",
      },
      {
        headers: {
          "X-XSRF-TOKEN": expireCache.get("aggietime-csrf"),
        },
      },
    )
    .then(({ data }) => {
      expireCache.remove("status_line");
      return data;
    });
};

// Actions

export const clock_in = async (rest) => do_clock_mutation(CLOCKIN_PATH, rest);
export const clock_out = async (rest) => do_clock_mutation(CLOCKOUT_PATH, rest);

export const current_shift = async () => {
  const req_path = replace_path_args(OPEN_SHIFT_PATH, await get_user_info());

  try {
    const resp = await aggietime.get(req_path);
    return resp.data;
  } catch (e) {
    if (e.response && e.response.status === 404) {
      return null;
    }
    throw e;
  }
};

export const get_status_line = async () => {
  if (!expireCache.get("status_line")) {
    const { anumber } = await get_user_info();
    const shift = await current_shift();
    let status_line = "No Shift";

    if (shift && shift?.start) {
      const start = new Date(shift?.start);
      status_line =
        ((new Date().getTime() - start.getTime()) / (1000 * 60 * 60)).toFixed(
          2,
        ) + " hours";
    }

    expireCache.set(
      "status_line",
      `${anumber} - ${status_line}`,
      OPEN_SHIFT_EXP_SEC,
    );
  }
  return { status: expireCache.get("status_line") };
};

export const last_week = async (args) => {
  const position_id = await get_user_position_or_specified(args.position_id);
  const [start, end] = [
    ((d) => {
      const day = d.getDay();
      const diff = d.getDate() - day + (day == 0 ? -6 : 1);
      return new Date(d.setDate(diff));
    })(new Date()),
    new Date(),
  ].map((d) => d.toISOString().split("T")[0]);

  if (!expireCache.get("past_week")) {
    const { anumber } = await get_user_info();

    const hours = await aggietime
      .get(replace_path_args(SUMMARY_PATH, { position_id, start, end }))
      .then(({ data: { undisputed_hours } }) => undisputed_hours);

    expireCache.set(
      "past_week",
      `${anumber} - ${hours} hours`,
      PAST_WEEK_EXP_SEC,
    );
  }
  return { status: expireCache.get("past_week") };
};
