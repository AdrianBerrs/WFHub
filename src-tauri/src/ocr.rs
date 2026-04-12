use std::collections::HashMap;

use image::{DynamicImage, GenericImageView, Pixel, Rgb};
use rayon::iter::{IntoParallelIterator, ParallelIterator};

use crate::theme::Theme;

const PIXEL_REWARD_WIDTH: f32 = 968.0;
const PIXEL_REWARD_HEIGHT: f32 = 235.0;
const PIXEL_REWARD_YDISPLAY: f32 = 316.0;
const PIXEL_REWARD_LINE_HEIGHT: f32 = 48.0;

fn debug_artifacts_enabled() -> bool {
    matches!(std::env::var("WFHUB_DEBUG_FILES").as_deref(), Ok("1"))
}

pub fn detect_theme(image: &DynamicImage) -> Theme {
    let screen_scaling = if image.width() * 9 > image.height() * 16 {
        image.height() as f32 / 1080.0
    } else {
        image.width() as f32 / 1920.0
    };

    let line_height = PIXEL_REWARD_LINE_HEIGHT / 2.0 * screen_scaling;
    let most_width = PIXEL_REWARD_WIDTH * screen_scaling;
    let min_width = most_width / 4.0;

    let weights = (line_height as u32..image.height())
        .into_par_iter()
        .fold(HashMap::new, |mut weights: HashMap<Theme, f32>, y| {
            let perc = (y as f32 - line_height) / (image.height() as f32 - line_height);
            let total_width = min_width * perc + min_width;
            for x in 0..total_width as u32 {
                let closest = Theme::closest_from_color(
                    image
                        .get_pixel(x + (most_width - total_width) as u32 / 2, y)
                        .to_rgb(),
                );

                *weights.entry(closest.0).or_insert(0.0) += 1.0 / (1.0 + closest.1).powi(4);
            }
            weights
        })
        .reduce(HashMap::new, |mut a, b| {
            for (k, v) in b {
                *a.entry(k).or_insert(0.0) += v;
            }
            a
        });

    weights
        .iter()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .unwrap()
        .0
        .to_owned()
}

pub fn extract_parts(image: &DynamicImage, theme: Theme) -> Vec<DynamicImage> {
    if debug_artifacts_enabled() {
        let _ = image.save("/tmp/wfinfo_input.png");
    }
    let screen_scaling = if image.width() * 9 > image.height() * 16 {
        image.height() as f32 / 1080.0
    } else {
        image.width() as f32 / 1920.0
    };
    let line_height = (PIXEL_REWARD_LINE_HEIGHT / 2.0 * screen_scaling) as usize;

    let width = image.width() as f32;
    let height = image.height() as f32;
    let most_width = PIXEL_REWARD_WIDTH * screen_scaling;
    let most_left = width / 2.0 - most_width / 2.0;
    let most_top = height / 2.0
        - ((PIXEL_REWARD_YDISPLAY - PIXEL_REWARD_HEIGHT + PIXEL_REWARD_LINE_HEIGHT)
            * screen_scaling);
    let most_bot =
        height / 2.0 - ((PIXEL_REWARD_YDISPLAY - PIXEL_REWARD_HEIGHT) * screen_scaling);

    let prefilter = image.crop_imm(
        most_left as u32,
        most_top as u32,
        most_width as u32,
        (most_bot - most_top) as u32,
    );
    let mut prefilter_draw = prefilter.clone().into_rgb8();
    let _ = prefilter.save("/tmp/wfinfo_prefilter.png");

    let mut rows = Vec::<usize>::new();
    for y in 0..prefilter.height() {
        let mut count = 0;
        for x in 0..prefilter.width() {
            let color = prefilter.get_pixel(x, y).to_rgb();
            if theme.threshold_filter(color) {
                count += 1;
            }
        }
        rows.push(count);
    }

    let mut perc_weights = Vec::new();
    let mut top_weights = Vec::new();
    let mut mid_weights = Vec::new();
    let mut bot_weights = Vec::new();

    let top_line_100 = prefilter.height() as usize - line_height;
    let top_line_50 = line_height / 2;

    let mut scaling = -1.0;
    let mut lowest_weight = 0.0;
    for i in 0..50 {
        let y_from_top = prefilter.height() as usize
            - (i as f32 * (top_line_100 - top_line_50) as f32 / 50.0 + top_line_50 as f32)
                as usize;
        let scale = 50 + i;
        let scale_width = (prefilter.width() as f32 * scale as f32 / 100.0) as usize;

        let text_segments = [2.0, 4.0, 16.0, 21.0];
        let text_top = (screen_scaling * text_segments[0] * scale as f32 / 100.0) as usize;
        let text_top_bot = (screen_scaling * text_segments[1] * scale as f32 / 100.0) as usize;
        let text_both_bot = (screen_scaling * text_segments[2] * scale as f32 / 100.0) as usize;
        let text_tail_bot = (screen_scaling * text_segments[3] * scale as f32 / 100.0) as usize;

        let mut w = 0.0;
        for loc in text_top..text_top_bot + 1 {
            w += (scale_width as f32 * 0.06 - rows[y_from_top + loc] as f32).abs();
            prefilter_draw.put_pixel(
                prefilter_draw.width() / 2 + i as u32,
                (y_from_top + loc) as u32,
                Rgb([255; 3]),
            );
        }
        top_weights.push(w);

        let mut w = 0.0;
        for loc in text_top_bot + 1..text_both_bot {
            if rows[y_from_top + loc] < scale_width / 15 {
                w += (scale_width as f32 * 0.26 - rows[y_from_top + loc] as f32) * 5.0;
            } else {
                w += (scale_width as f32 * 0.24 - rows[y_from_top + loc] as f32).abs();
            }
            prefilter_draw.put_pixel(
                prefilter_draw.width() / 2 + i as u32,
                (y_from_top + loc) as u32,
                Rgb([0, 255, 0]),
            );
        }
        mid_weights.push(w);

        let mut w = 0.0;
        for loc in text_both_bot..text_tail_bot {
            w += 10.0 * (scale_width as f32 * 0.007 - rows[y_from_top + loc] as f32).abs();
            prefilter_draw.put_pixel(
                prefilter_draw.width() / 2 + i as u32,
                (y_from_top + loc) as u32,
                Rgb([0, 0, 255]),
            );
        }
        bot_weights.push(w);

        top_weights[i] /= (text_top_bot - text_top + 1) as f32;
        mid_weights[i] /= (text_both_bot - text_top_bot - 2) as f32;
        bot_weights[i] /= (text_tail_bot - text_both_bot - 1) as f32;
        perc_weights.push(top_weights[i] + mid_weights[i] + bot_weights[i]);

        if scaling <= 0.0 || lowest_weight > perc_weights[i] {
            scaling = scale as f32;
            lowest_weight = perc_weights[i];
        }
    }

    let mut top_five = [-1_isize; 5];
    for (i, _w) in perc_weights.iter().enumerate() {
        let mut slot: isize = 4;
        while slot != -1
            && top_five[slot as usize] != -1
            && perc_weights[i] > perc_weights[top_five[slot as usize] as usize]
        {
            slot -= 1;
        }

        if slot != -1 {
            for slot2 in 0..slot {
                top_five[slot2 as usize] = top_five[slot2 as usize + 1];
            }
            top_five[slot as usize] = i as isize;
        }
    }

    scaling = top_five[4] as f32 + 50.0;
    scaling /= 100.0;
    let high_scaling = if scaling < 1.0 {
        scaling + 0.01
    } else {
        scaling
    };
    let low_scaling = if scaling > 0.5 {
        scaling - 0.01
    } else {
        scaling
    };

    let crop_width = PIXEL_REWARD_WIDTH * screen_scaling * high_scaling;
    let crop_left = prefilter.width() as f32 / 2.0 - crop_width / 2.0;
    let crop_top = height / 2.0
        - (PIXEL_REWARD_YDISPLAY - PIXEL_REWARD_HEIGHT + PIXEL_REWARD_LINE_HEIGHT)
            * screen_scaling
            * high_scaling;
    let crop_bot =
        height / 2.0 - (PIXEL_REWARD_YDISPLAY - PIXEL_REWARD_HEIGHT) * screen_scaling * low_scaling;
    let crop_hei = crop_bot - crop_top;
    let crop_top = crop_top - most_top;

    if crop_hei <= 0.0 || crop_width <= 0.0 || crop_top < 0.0 {
        return vec![];
    }

    let partial_screenshot = DynamicImage::ImageRgb8(prefilter.into_rgb8()).crop_imm(
        crop_left as u32,
        crop_top as u32,
        crop_width as u32,
        crop_hei as u32,
    );

    for (i, y) in top_five.iter().enumerate() {
        for x in 0..prefilter_draw.width() {
            prefilter_draw.put_pixel(x, *y as u32, Rgb([255 - i as u8 * 50, 0, 0]));
        }
    }
    for (y, row) in rows.iter().enumerate() {
        for x in 0..*row {
            prefilter_draw.put_pixel(x as u32, y as u32, Rgb([0, 255, 0]));
        }
    }

    if debug_artifacts_enabled() {
        let _ = partial_screenshot.save("/tmp/wfinfo_partial_screenshot.png");
    }

    filter_and_separate_parts_from_part_box(partial_screenshot, theme)
}

fn remove_large_white_blobs(image: &mut image::RgbImage, max_size: usize) {
    let width = image.width() as i32;
    let height = image.height() as i32;
    let mut visited = vec![false; (width * height) as usize];

    for sy in 0..height {
        for sx in 0..width {
            let idx = (sy * width + sx) as usize;
            if visited[idx] || image.get_pixel(sx as u32, sy as u32).0 != [255u8, 255, 255] {
                visited[idx] = true;
                continue;
            }
            let mut component: Vec<(u32, u32)> = Vec::new();
            let mut stack = vec![(sx, sy)];
            visited[idx] = true;
            while let Some((x, y)) = stack.pop() {
                component.push((x as u32, y as u32));
                for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
                    let nx = x + dx;
                    let ny = y + dy;
                    if nx < 0 || ny < 0 || nx >= width || ny >= height {
                        continue;
                    }
                    let ni = (ny * width + nx) as usize;
                    if !visited[ni]
                        && image.get_pixel(nx as u32, ny as u32).0 == [255u8, 255, 255]
                    {
                        visited[ni] = true;
                        stack.push((nx, ny));
                    }
                }
            }
            if component.len() > max_size {
                for (x, y) in component {
                    image.put_pixel(x, y, Rgb([0; 3]));
                }
            }
        }
    }
}

fn find_text_start_row(image: &image::RgbImage) -> u32 {
    let width = image.width();
    let min_black = (width as f32 * 0.05) as u32;
    let mut consecutive = 0u32;
    let mut candidate = 0u32;

    for y in 0..image.height() {
        let black = (0..width)
            .filter(|&x| image.get_pixel(x, y).0 == [0u8, 0, 0])
            .count() as u32;

        if black >= min_black {
            if consecutive == 0 {
                candidate = y;
            }
            consecutive += 1;
            if consecutive >= 3 {
                return candidate;
            }
        } else {
            consecutive = 0;
        }
    }

    0
}

pub fn filter_and_separate_parts_from_part_box(
    image: DynamicImage,
    theme: Theme,
) -> Vec<DynamicImage> {
    let mut filtered = image.into_rgb8();
    let width = filtered.width();
    let height = filtered.height();

    let mut col_counts: Vec<u32> = vec![0; width as usize];
    for x in 0..width {
        let mut count = 0u32;
        for y in 0..height {
            let pixel = filtered.get_pixel_mut(x, y);
            if theme.threshold_filter(*pixel) {
                *pixel = Rgb([0; 3]);
                count += 1;
            } else {
                *pixel = Rgb([255; 3]);
            }
        }
        col_counts[x as usize] = count;
    }

    let _ = filtered.save("/tmp/filtered.png");

    if col_counts.iter().all(|&c| c == 0) {
        return vec![];
    }

    let splits = [width / 4, width / 2, 3 * width / 4];
    let dynamic_image = DynamicImage::ImageRgb8(filtered);
    let mut images = Vec::new();

    let boundaries: Vec<u32> = std::iter::once(0)
        .chain(splits.iter().copied())
        .chain(std::iter::once(width))
        .collect();

    for (i, window) in boundaries.windows(2).enumerate() {
        let left = window[0];
        let width = window[1] - left;
        let mut part = dynamic_image.crop_imm(left, 0, width, height).into_rgb8();

        let text_start = find_text_start_row(&part);
        for y in 0..text_start {
            for x in 0..part.width() {
                part.put_pixel(x, y, Rgb([0; 3]));
            }
        }

        let blob_threshold = (part.width() * part.height()) as usize;
        remove_large_white_blobs(&mut part, blob_threshold);
        let cleaned = DynamicImage::ImageRgb8(part);
        cleaned.save(format!("/tmp/part_{i}.png")).unwrap();
        images.push(cleaned);
    }

    images
}
